import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/employee.dart';
import '../services/i18n.dart';
import '../services/theme_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// The badge screen — where every shift starts and where the device sits
/// whenever nobody is working it.
///
/// There is no password here by design. The terminal is already authenticated
/// as itself, and who is holding it is answered by a badge: a printed QR read
/// by the imager, an RFID employee card, or a tap on a name. All three end up
/// in [AppController.badgeScanned] / [AppController.identifyAs].
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _focus = FocusNode();

  /// The scan lands here. A barcode imager in keyboard-wedge mode types the
  /// code like a keyboard would, so the capture surface is a real (invisible)
  /// text field rather than a raw key listener: a field is what actually holds
  /// input focus on every platform — on web, raw key events never reach the
  /// app at all unless something focusable owns them — and `TextInputType.none`
  /// keeps the on-screen keyboard away on the handheld, where there is nothing
  /// to type by hand.
  final _badge = TextEditingController();
  Timer? _flush;

  /// เวลาที่ตัวอักษรก่อนหน้ามาถึง — ใช้วัดจังหวะห่างระหว่างตัวอักษรของรอบกรอกนี้
  DateTime? _lastKeyAt;
  /// true เมื่อเจอจังหวะกดแบบคนพิมพ์ (ห่างเกิน [_scanGapMs]) อย่างน้อยหนึ่งครั้งใน
  /// รอบกรอกนี้ — ตัวสแกน (keyboard-wedge) พ่นตัวอักษรเร็วกว่านี้มาก (ปกติ <20ms/ตัว)
  /// ดังนั้นถ้าเจอช่องว่างยาวขนาดนี้แม้แต่ครั้งเดียว แสดงว่าเป็นคนพิมพ์เอง ไม่ใช่สแกน
  bool _looksTyped = false;

  static const _scanGapMs = 80;
  static const _scanFlushMs = 220;

  @override
  void initState() {
    super.initState();
    // A stray tap on the background is enough to drop focus, after which the
    // reader would look dead with nothing on screen to say why. Take it back
    // whenever it is lost, so the badge screen is always listening.
    _focus.addListener(_keepFocus);
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  void _keepFocus() {
    if (!mounted || _focus.hasFocus) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_focus.hasFocus) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _flush?.cancel();
    _focus.removeListener(_keepFocus);
    _focus.dispose();
    _badge.dispose();
    super.dispose();
  }

  void _submitBadge() {
    _flush?.cancel();
    final code = _badge.text;
    _badge.clear();
    _lastKeyAt = null;
    if (_looksTyped) setState(() => _looksTyped = false);
    if (code.trim().isEmpty) return;
    context.read<AppController>().badgeScanned(code);
  }

  /// จังหวะตัวอักษรมาถึงคือสิ่งที่แยกสแกน-กับ-พิมพ์เองได้จริง ไม่ใช่แค่ "หยุดนิ่งกี่ ms"
  /// อย่างเดิม — เดิมยิง submit อัตโนมัติทุกครั้งที่หยุดพิมพ์ 250ms ไม่ว่าจะพิมพ์เองหรือ
  /// สแกน ถ้าคนพิมพ์เว้นจังหวะคิดเลขระหว่างตัวเกิน 250ms (ปกติมาก) ระบบจะยิง submit
  /// ทั้งที่กรอกไม่ครบ
  ///
  /// จุดพลาดที่เจอตอนทดสอบ (สำคัญ ต้องจำไว้): ห้ามตั้งเวลานับถอยหลังไว้ล่วงหน้า
  /// "เผื่อ" ว่าตัวถัดไปจะมาเร็ว แล้วค่อยยกเลิกทีหลังถ้าเจอจังหวะช้า — เพราะถ้าคน
  /// พิมพ์ตัวถัดไปช้ากว่าเวลาที่ตั้งไว้ (เช่น พิมพ์ห่างกัน 400ms แต่ตั้ง timer ไว้แค่
  /// 220ms) ตัว timer จะยิง submit ทิ้งไปก่อนที่จะได้เห็นจังหวะช้านั้นด้วยซ้ำ กลาย
  /// เป็นส่ง submit ทีละตัวอักษรตลอดการพิมพ์ วิธีที่ถูกคือ "ห้ามตั้ง timer ล่วงหน้า
  /// เด็ดขาด — ตั้งได้ก็ต่อเมื่อเพิ่งเห็นจังหวะจริงระหว่างตัวอักษร 2 ตัวที่พิมพ์มาแล้ว
  /// ว่าเร็วแบบสแกนเท่านั้น" ตัวอักษรตัวแรกของรอบกรอกจึงไม่มีวันไปตั้ง timer เอง
  /// (ยังไม่มีจังหวะให้เทียบ) ต้องรอตัวที่สองมาก่อนเสมอ
  void _onBadgeChanged(String v) {
    _flush?.cancel();
    final now = DateTime.now();
    if (v.isEmpty) {
      _lastKeyAt = null;
      setState(() => _looksTyped = false);
      return;
    }
    final prev = _lastKeyAt;
    _lastKeyAt = now;
    setState(() {}); // repaint the confirm button's enabled state regardless
    if (prev == null) return; // first char of this entry — no gap to judge yet
    final gapMs = now.difference(prev).inMilliseconds;
    if (gapMs > _scanGapMs) {
      if (!_looksTyped) setState(() => _looksTyped = true);
      return; // a human-speed gap was just confirmed — never auto-submit again
    }
    if (_looksTyped) return; // an earlier gap already flagged this as manual entry
    // This exact gap just arrived at scanner speed, so arm a short quiet-period
    // check — reacting to a gap that already happened, never predicting one.
    _flush = Timer(const Duration(milliseconds: _scanFlushMs), _submitBadge);
  }

  /// The capture field, shown rather than hidden.
  ///
  /// A zero-sized invisible field turned out never to establish a text input
  /// connection at all on web — no DOM input is created, so not one character
  /// ever arrives. Showing it fixes that, and is the better design anyway: the
  /// caret is the operator's proof that the terminal is armed and waiting for a
  /// badge, and a damaged badge can be keyed in by hand instead of stranding
  /// someone at the gate.
  Widget _captureField(LocaleController loc) => TextField(
        controller: _badge,
        focusNode: _focus,
        autofocus: true,
        // On the handheld the scanner does the typing, so keep the on-screen
        // keyboard away; web has a real keyboard and treats TextInputType.none
        // as "no text connection", which delivers nothing at all.
        keyboardType: kIsWeb ? TextInputType.text : TextInputType.none,
        textAlign: TextAlign.center,
        autocorrect: false,
        enableSuggestions: false,
        textCapitalization: TextCapitalization.characters,
        style: TextStyle(
            fontSize: 16, fontWeight: FontWeight.w600, letterSpacing: 1.2, color: C.onInk),
        cursorColor: C.lime,
        decoration: InputDecoration(
          hintText: loc.t('ยิงบัตร หรือพิมพ์รหัสพนักงาน'),
          hintStyle: TextStyle(
              fontSize: 13.5,
              letterSpacing: 0,
              fontWeight: FontWeight.w500,
              color: C.onInk.withValues(alpha: 0.42)),
          isDense: true,
          filled: true,
          fillColor: C.onInk.withValues(alpha: 0.08),
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          // ปุ่มยืนยันด้วยมือเสมอ ไม่ใช่แค่ตอนพิมพ์เอง — เผื่อกรณีสแกนไม่จบ (การ์ดเสีย
          // ครึ่งใบ) หรืออุปกรณ์ไม่ต่อ Enter suffix มาให้ ผู้ใช้ก็ยังกดจบเองได้เสมอ
          suffixIcon: _badge.text.trim().isEmpty
              ? null
              : IconButton(
                  icon: Icon(Icons.check_circle, color: C.lime),
                  tooltip: loc.t('ยืนยัน'),
                  onPressed: _submitBadge,
                ),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(13),
            borderSide: BorderSide(color: C.onInk.withValues(alpha: 0.16)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(13),
            borderSide: BorderSide(color: C.onInk.withValues(alpha: 0.16)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(13),
            borderSide: BorderSide(color: C.lime, width: 1.5),
          ),
        ),
        onChanged: _onBadgeChanged,
        onSubmitted: (_) => _submitBadge(),
      );

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final themeCtrl = context.watch<ThemeController>();
    final top = MediaQuery.of(context).padding.top;
    final bottom = MediaQuery.of(context).padding.bottom;
    final people = c.employees;

    return Column(
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(22, top + 26, 22, 4),
            child: Row(
              children: [
                const BrandMark(size: 40),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Wordmark(),
                      Text(
                        !c.deviceConfigured
                            ? loc.t('ยังไม่ได้ตั้งค่าเครื่อง')
                            : (c.wh.isNotEmpty && c.gate.isNotEmpty)
                                ? '${c.selWhName} · ${loc.t('ประตู')} ${c.gate}'
                                : loc.t('ยังไม่ได้เลือกคลัง/ประตู'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, color: C.muted),
                      ),
                    ],
                  ),
                ),
                LangToggleButton(loc: loc),
                const SizedBox(width: 8),
                ThemeToggleButton(ctrl: themeCtrl),
              ],
            ),
          ),
          if (!c.connected)
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 10, 22, 0),
              child: _Notice(
                text: c.connError == null
                    ? loc.t('ยังไม่พบข้อมูลจากระบบหลัก BoxTrace — แตะปุ่มด้านล่างเพื่อตั้งค่าการเชื่อมต่อ')
                    : '${loc.t('เชื่อมต่อไม่ได้')}: ${c.connError}',
                actionLabel: loc.t('ตั้งค่าการเชื่อมต่อ'),
                onAction: c.goDeviceSetup,
              ),
            ),
          _BadgePrompt(field: _captureField(loc)),
          if (people.isEmpty)
            Expanded(
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    loc.t(c.connected ? 'ยังไม่มีพนักงานในระบบ' : 'รอเชื่อมต่อกับระบบหลักก่อน'),
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13.5, color: C.faint),
                  ),
                ),
              ),
            )
          else
            Expanded(
              child: ListView(
                padding: EdgeInsets.fromLTRB(22, 4, 22, bottom + 20),
                children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Text(loc.t('หรือแตะชื่อของคุณ'),
                        style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w600)),
                  ),
                  ...people.map((e) => Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: _EmployeeTile(
                          emp: e,
                          visiting: c.isVisiting(e),
                          onTap: () {
                            final err = c.identifyAs(e);
                            if (err != null) c.toastMsg(err, '', ResultKind.err);
                          },
                        ),
                      )),
                ],
              ),
            ),
        ],
    );
  }
}

/// The "scan your badge" hero, wrapping the capture field so the instruction
/// and the thing that actually receives the scan are one object on screen.
class _BadgePrompt extends StatelessWidget {
  final Widget field;
  const _BadgePrompt({required this.field});

  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocaleController>();
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 18),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 26, horizontal: 18),
        decoration: BoxDecoration(
          color: C.ink,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
              decoration: BoxDecoration(
                color: C.onInk.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(Icons.qr_code_2, size: 44, color: C.lime),
            ),
            const SizedBox(height: 16),
            Text(
              loc.t('ยิงบัตรพนักงานเพื่อเริ่มงาน'),
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 19, fontWeight: FontWeight.w700, color: C.onInk, letterSpacing: -0.3),
            ),
            const SizedBox(height: 6),
            Text(
              loc.t('ทุกการยิงเข้า–ออกจะบันทึกในชื่อผู้ที่ยิงบัตร'),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: C.onInk.withValues(alpha: 0.62), height: 1.4),
            ),
            const SizedBox(height: 16),
            field,
          ],
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  final String text;
  final String actionLabel;
  final VoidCallback onAction;
  const _Notice({required this.text, required this.actionLabel, required this.onAction});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
      decoration: BoxDecoration(
        color: C.orangeBg,
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: C.orangeBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text,
              style: TextStyle(fontSize: 13, color: C.orange, fontWeight: FontWeight.w600, height: 1.45)),
          const SizedBox(height: 9),
          OutlinedButton(
            onPressed: onAction,
            style: OutlinedButton.styleFrom(
              foregroundColor: C.orange,
              side: BorderSide(color: C.orangeBorder),
              padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
            ),
            child: Text(actionLabel, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}

class _EmployeeTile extends StatelessWidget {
  final Employee emp;
  final bool visiting;
  final VoidCallback onTap;
  const _EmployeeTile({required this.emp, required this.visiting, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final sub = emp.subtitle;
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: C.border),
            boxShadow: [
              BoxShadow(color: Colors.black.withValues(alpha: 0.04), blurRadius: 2, offset: const Offset(0, 1))
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(color: C.neutralBg, shape: BoxShape.circle),
                alignment: Alignment.center,
                child: Text(emp.initials,
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: C.ink2)),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(emp.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: C.ink)),
                    if (sub.isNotEmpty)
                      Text(sub,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12.5, color: C.muted)),
                  ],
                ),
              ),
              if (visiting) ...[
                Pill('ต่างคลัง', color: C.orange, bg: C.orangeBg),
                const SizedBox(width: 6),
              ],
              Icon(Icons.chevron_right, color: C.chevron, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}
