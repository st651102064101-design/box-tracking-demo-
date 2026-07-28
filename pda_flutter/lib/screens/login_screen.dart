import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

  /// Characters accumulated from the imager since the last submit. DataWedge
  /// in keyboard-wedge mode delivers a scan as a burst of key events, so this
  /// screen listens for raw keys rather than focusing a text field — that way
  /// the soft keyboard never appears on a device with no text to type.
  final StringBuffer _buf = StringBuffer();
  Timer? _flush;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _flush?.cancel();
    _focus.dispose();
    super.dispose();
  }

  void _submitBuffer() {
    _flush?.cancel();
    final code = _buf.toString();
    _buf.clear();
    if (code.trim().isEmpty) return;
    context.read<AppController>().badgeScanned(code);
  }

  KeyEventResult _onKey(FocusNode _, KeyEvent e) {
    if (e is! KeyDownEvent) return KeyEventResult.ignored;

    if (e.logicalKey == LogicalKeyboardKey.enter ||
        e.logicalKey == LogicalKeyboardKey.numpadEnter ||
        e.logicalKey == LogicalKeyboardKey.tab) {
      _submitBuffer();
      return KeyEventResult.handled;
    }

    final ch = e.character;
    if (ch == null || ch.isEmpty || ch.codeUnitAt(0) < 0x20) return KeyEventResult.ignored;
    _buf.write(ch);
    // Not every DataWedge profile appends an Enter suffix. Nothing else types
    // on this screen, so a short pause is a safe end-of-scan signal.
    _flush?.cancel();
    _flush = Timer(const Duration(milliseconds: 250), _submitBuffer);
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final themeCtrl = context.watch<ThemeController>();
    final top = MediaQuery.of(context).padding.top;
    final bottom = MediaQuery.of(context).padding.bottom;
    final people = c.employees;

    return Focus(
      focusNode: _focus,
      autofocus: true,
      onKeyEvent: _onKey,
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
                        c.deviceConfigured
                            ? '${c.selWhName} · ${loc.t('ประตู')} ${c.gate}'
                            : loc.t('ยังไม่ได้ตั้งค่าเครื่อง'),
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
          const _BadgePrompt(),
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
      ),
    );
  }
}

/// The "scan your badge" hero — the only instruction on the screen.
class _BadgePrompt extends StatelessWidget {
  const _BadgePrompt();

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
                color: Colors.white.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(Icons.qr_code_2, size: 44, color: C.lime),
            ),
            const SizedBox(height: 16),
            Text(
              loc.t('ยิงบัตรพนักงานเพื่อเริ่มงาน'),
              textAlign: TextAlign.center,
              style: const TextStyle(
                  fontSize: 19, fontWeight: FontWeight.w700, color: Colors.white, letterSpacing: -0.3),
            ),
            const SizedBox(height: 6),
            Text(
              loc.t('ทุกการยิงเข้า–ออกจะบันทึกในชื่อผู้ที่ยิงบัตร'),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: Colors.white.withValues(alpha: 0.62), height: 1.4),
            ),
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
