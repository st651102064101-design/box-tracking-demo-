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
import '../widgets/pin_pad.dart';

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
  /// ความยาวข้อความหลัง onChanged ครั้งก่อน — บาง build ของคีย์บอร์ด-wedge (โดยเฉพาะ
  /// เครื่อง MC3390R ที่ต้อง fallback ไป Android เก่า) ส่งทั้งรหัสมาในเหตุการณ์ onChanged
  /// เดียว ไม่ใช่ทีละตัวอักษร ถ้าเทียบจังหวะระหว่างตัวอักษรไม่ได้เพราะตัวเดียวมาครบเลย
  /// ก็ต้องดูจากตรงนี้แทน: เพิ่มมากกว่า 1 ตัวอักษรในเหตุการณ์เดียวคือมนุษย์พิมพ์ไม่ทัน
  /// แน่นอน จึงถือเป็นหลักฐานว่าเป็นการสแกนได้เลย
  int _prevLen = 0;
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
    _prevLen = 0;
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
      _prevLen = 0;
      setState(() => _looksTyped = false);
      return;
    }
    final addedChars = v.length - _prevLen;
    _prevLen = v.length;
    final prev = _lastKeyAt;
    _lastKeyAt = now;
    setState(() {}); // repaint the confirm button's enabled state regardless
    // Some keyboard-wedge implementations (seen on the MC3390R's older Android
    // build) deliver the whole scanned code in one onChanged call instead of
    // one call per keystroke, so there is never a second call to measure a
    // gap between. No human adds more than one character between two frames,
    // so more than one new character in a single callback is scan-speed proof
    // on its own — treat it the same as a fast inter-key gap, below.
    if (addedChars > 1) {
      if (_looksTyped) return;
      _flush = Timer(const Duration(milliseconds: _scanFlushMs), _submitBadge);
      return;
    }
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

  /// Tapping a name is a shortcut for a badge scan, so it goes through the
  /// same PIN gate: first tap ever offers to set a 4-digit PIN (or skip),
  /// every tap after that — once one is set — asks for it before starting the
  /// session. The PIN itself is verified against a bcrypt hash on the backend
  /// (see `ApiClient.setEmployeePin`/`verifyEmployeePin`), so it works the
  /// same on every PDA an employee badges into, not just this device — only
  /// the "did they skip on this device" memory is local (see [Prefs.pinSkipped]).
  Future<void> _tapEmployee(Employee e) async {
    final c = context.read<AppController>();

    if (e.hasPin) {
      await _verifyThenEnter(e);
      return;
    }
    if (c.prefs.pinSkipped(e.id)) {
      final err = c.identifyAs(e);
      if (err != null) c.toastMsg(err, '', ResultKind.err);
      return;
    }

    final result = await showPinPad(
      context,
      title: 'ตั้งรหัส PIN สำหรับ ${e.name}',
      subtitle: 'ตั้งรหัส 4 หลักไว้กันคนอื่นแตะชื่อคุณเข้าใช้งาน — ข้ามได้ถ้าไม่ต้องการ',
      allowSkip: true,
    );
    if (result == null) return; // dismissed — ask again next time
    if (result.skipped) {
      c.prefs.skipPin(e.id);
      if (!mounted) return;
      final err = c.identifyAs(e);
      if (err != null) c.toastMsg(err, '', ResultKind.err);
      return;
    }
    if (result.pin == null) return;
    final firstPin = result.pin!;
    // Confirm before saving — a mistyped first entry would otherwise lock the
    // operator out of their own name with a PIN they never meant to set.
    final confirm = await showPinPad(
      context,
      title: 'ยืนยันรหัส PIN อีกครั้ง',
      subtitle: 'พิมพ์รหัส 4 หลักเดิมอีกครั้งเพื่อยืนยัน',
      validate: (entered) async => entered == firstPin ? null : 'รหัสไม่ตรงกัน ลองใหม่',
    );
    if (confirm == null || confirm.pin == null) return; // cancelled — nothing saved
    if (!mounted) return;
    try {
      await c.api.setEmployeePin(e.id, firstPin);
    } catch (err) {
      if (!mounted) return;
      c.toastMsg('ตั้งรหัส PIN ไม่สำเร็จ', '$err', ResultKind.err);
      return;
    }
    c.prefs.clearPinSkip(e.id);
    // Backend now has the PIN, but the cached employee list won't say
    // `hasPin: true` until the next `/api/state` fetch — patch it locally so
    // a lock/re-badge later in this same session doesn't ask to set it again.
    c.markPinSet(e.id);
    if (!mounted) return;
    final err = c.identifyAs(e);
    if (err != null) c.toastMsg(err, '', ResultKind.err);
  }

  Future<void> _verifyThenEnter(Employee e) async {
    final c = context.read<AppController>();
    final result = await showPinPad(
      context,
      title: 'ใส่รหัส PIN ของ ${e.name}',
      showForgot: true,
      validate: (entered) async {
        try {
          final ok = await c.api.verifyEmployeePin(e.id, entered);
          return ok ? null : 'รหัสไม่ถูกต้อง ลองใหม่';
        } catch (err) {
          return 'ตรวจสอบรหัสไม่สำเร็จ — เช็คการเชื่อมต่อแล้วลองใหม่';
        }
      },
    );
    if (result == null) return; // cancelled
    if (result.forgot) {
      await _forgotPin(e);
      return;
    }
    if (result.pin == null) return;
    if (!mounted) return;
    final err = c.identifyAs(e);
    if (err != null) c.toastMsg(err, '', ResultKind.err);
  }

  /// "ลืมรหัส PIN?" — mints a 6-digit OTP and emails it straight to whatever
  /// address is on this employee's own record (see backend/src/routes/pin.ts).
  /// No admin in the loop: unlike the shared PDA there's a real inbox only
  /// that person can read, so there's no second person needed to relay it.
  Future<void> _forgotPin(Employee e) async {
    final c = context.read<AppController>();
    Map<String, dynamic> req;
    try {
      req = await c.api.requestPinReset(e.id);
    } catch (err) {
      if (!mounted) return;
      c.toastMsg('ขอรหัส OTP ไม่สำเร็จ', '$err', ResultKind.err);
      return;
    }

    if (!mounted) return;
    final sentTo = req['sentTo']?.toString();
    c.toastMsg(
      'ส่งรหัส OTP แล้ว',
      sentTo != null ? 'ส่งไปที่อีเมล $sentTo แล้ว — กรอกรหัส 6 หลักด้านล่าง' : 'เช็คอีเมลของคุณแล้วกรอกรหัส 6 หลักด้านล่าง',
      ResultKind.info,
    );
    final otpResult = await showPinPad(
      context,
      title: 'กรอกรหัส OTP',
      subtitle: 'รหัส 6 หลักที่ส่งไปทางอีเมล (มีอายุ 5 นาที)',
      length: 6,
    );
    if (otpResult == null || otpResult.pin == null) return;
    final otp = otpResult.pin!;

    if (!mounted) return;
    final newPinResult = await showPinPad(
      context,
      title: 'ตั้งรหัส PIN ใหม่สำหรับ ${e.name}',
    );
    if (newPinResult == null || newPinResult.pin == null) return;
    final newPin = newPinResult.pin!;

    if (!mounted) return;
    final confirm = await showPinPad(
      context,
      title: 'ยืนยันรหัส PIN ใหม่อีกครั้ง',
      validate: (entered) async => entered == newPin ? null : 'รหัสไม่ตรงกัน ลองใหม่',
    );
    if (confirm == null || confirm.pin == null) return;

    if (!mounted) return;
    try {
      await c.api.confirmPinReset(e.id, otp: otp, pin: newPin);
    } catch (err) {
      if (!mounted) return;
      c.toastMsg('รีเซ็ต PIN ไม่สำเร็จ', '$err', ResultKind.err);
      return;
    }
    c.prefs.clearPinSkip(e.id);
    if (!mounted) return;
    c.toastMsg('ตั้งรหัส PIN ใหม่แล้ว', '', ResultKind.ok);
    final err = c.identifyAs(e);
    if (err != null) c.toastMsg(err, '', ResultKind.err);
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
            fontSize: 16, fontWeight: FontWeight.w600, letterSpacing: 1.2, color: C.onHero),
        cursorColor: C.lime,
        decoration: InputDecoration(
          hintText: loc.t('ยิงบัตร หรือพิมพ์รหัสพนักงาน'),
          hintStyle: TextStyle(
              fontSize: 13.5,
              letterSpacing: 0,
              fontWeight: FontWeight.w500,
              color: C.onHero.withValues(alpha: 0.42)),
          isDense: true,
          filled: true,
          fillColor: C.onHero.withValues(alpha: 0.08),
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
            borderSide: BorderSide(color: C.onHero.withValues(alpha: 0.16)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(13),
            borderSide: BorderSide(color: C.onHero.withValues(alpha: 0.16)),
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

    // A plain Column here forced the header + badge prompt to a fixed height
    // and only let the employee list underneath scroll on its own — on the
    // handheld's short screen that clipped everything below the fold with no
    // way to reach it. One scroll view for the whole page instead, so the
    // page scrolls as a unit whenever it doesn't fit.
    return SingleChildScrollView(
      padding: EdgeInsets.only(bottom: bottom + 20),
      child: Column(
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
          // Everything below the header scrolls as one unit — the badge-scan
          // card used to be pinned outside the list, which left it stuck in
          // place (and could crowd out the employee list, or sit half-hidden
          // behind the keyboard) on shorter screens. Now a scan/tap-name flow
          // is one continuous scrollable column, header excepted.
          // Plain Column, not a nested ListView+Expanded — Expanded needs a
          // bounded height from a parent Flex, but this Column sits inside
          // the page's SingleChildScrollView, which hands down unbounded
          // height. That combination renders nothing below the header at
          // all on web release builds (no visible error, just a blank page).
          Column(
            children: [
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
                Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    loc.t(c.connected ? 'ยังไม่มีพนักงานในระบบ' : 'รอเชื่อมต่อกับระบบหลักก่อน'),
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13.5, color: C.faint),
                  ),
                )
              else
                Padding(
                  padding: const EdgeInsets.fromLTRB(22, 4, 22, 0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
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
                              isLast: e.id == c.lastEmpId,
                              onTap: () => _tapEmployee(e),
                            ),
                          )),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
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
          color: C.heroBg,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
              decoration: BoxDecoration(
                color: C.onHero.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(Icons.qr_code_2, size: 44, color: C.lime),
            ),
            const SizedBox(height: 16),
            Text(
              loc.t('ยิงบัตรพนักงานเพื่อเริ่มงาน'),
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 19, fontWeight: FontWeight.w700, color: C.onHero, letterSpacing: -0.3),
            ),
            const SizedBox(height: 6),
            Text(
              loc.t('ทุกการยิงเข้า–ออกจะบันทึกในชื่อผู้ที่ยิงบัตร'),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: C.onHero.withValues(alpha: 0.62), height: 1.4),
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
  final bool isLast;
  final VoidCallback onTap;
  const _EmployeeTile({
    required this.emp,
    required this.visiting,
    required this.onTap,
    this.isLast = false,
  });

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
            // The last person to work this device is already sorted to the
            // top; the accent border is what makes that visible at a glance
            // rather than looking like an arbitrary sort order.
            border: Border.all(color: isLast ? C.limeBorder : C.border, width: isLast ? 1.5 : 1),
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
              if (isLast) ...[
                Pill('ล่าสุด', color: C.limeText, bg: C.limeBg),
                const SizedBox(width: 6),
              ],
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
