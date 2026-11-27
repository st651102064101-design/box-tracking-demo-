import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/employee.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/pin_pad.dart';
import '../widgets/scan_capture.dart';

/// The badge screen — where every shift starts and where the device sits
/// whenever nobody is working it.
///
/// There is no password here by design. The terminal is already authenticated
/// as itself, and who is holding it is answered by a badge: a printed QR read
/// by the imager, an RFID employee card, or a tap on a name. All three end up
/// in [AppController.badgeScanned] / [AppController.identifyAs]. Typing an
/// employee code is an explicit fallback and follows the same PIN path as
/// tapping that employee's name.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> with WidgetsBindingObserver {
  final _badgeCodeController = TextEditingController();
  final _badgeCodeFocus = FocusNode(debugLabel: 'Employee badge code');
  bool _manualBadgeOpen = false;
  bool _badgeSubmitting = false;
  bool _keyboardSeen = false;
  Timer? _onlineLabelTimer;
  bool? _lastOnlineDisplay;
  bool _showOnlineLabel = true;
  int _onlineLabelGeneration = 0;

  void _syncOnlineLabel(bool online) {
    if (_lastOnlineDisplay == online) return;
    _lastOnlineDisplay = online;
    _onlineLabelTimer?.cancel();
    _showOnlineLabel = true;
    final generation = ++_onlineLabelGeneration;
    if (!online) return;
    // Start counting only after the online label has appeared on screen.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || generation != _onlineLabelGeneration) return;
      _onlineLabelTimer = Timer(const Duration(seconds: 5), () {
        if (mounted &&
            generation == _onlineLabelGeneration &&
            _lastOnlineDisplay == true) {
          setState(() => _showOnlineLabel = false);
        }
      });
    });
  }

  /// Physical badge reads retain their existing scanner path. A typed code
  /// goes through [_tapEmployee] instead, including its PIN check.
  void _submitBadge(String code) {
    if (code.trim().isEmpty) return;
    context.read<AppController>().badgeScanned(code);
  }

  Employee? _typedEmployee(AppController c) {
    final code = _badgeCodeController.text.trim().toUpperCase();
    if (code.isEmpty) return null;
    final matches = c.employees.where((employee) =>
        employee.id.toUpperCase() == code || employee.matchesCode(code));
    return matches.length == 1 ? matches.first : null;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  /// The keyboard can be put away (back key, its own hide button) while the
  /// field keeps focus, which would leave a cursor blinking on an idle screen.
  @override
  void didChangeMetrics() {
    if (!mounted || !_manualBadgeOpen) return;
    if (View.of(context).viewInsets.bottom > 0) {
      _keyboardSeen = true;
    } else if (_keyboardSeen) {
      _closeManualBadge();
    }
  }

  /// Back to the badge prompt, so the trigger reads badges again.
  void _closeManualBadge() {
    if (!_manualBadgeOpen) return;
    _badgeCodeFocus.unfocus();
    _badgeCodeController.clear();
    _keyboardSeen = false;
    setState(() => _manualBadgeOpen = false);
  }

  void _openManualBadge() {
    _keyboardSeen = false;
    setState(() => _manualBadgeOpen = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _badgeCodeFocus.requestFocus();
    });
  }

  Future<void> _submitTypedBadge() async {
    if (_badgeSubmitting) return;
    final employee = _typedEmployee(context.read<AppController>());
    if (employee == null) return;
    setState(() => _badgeSubmitting = true);
    try {
      await _tapEmployee(employee);
    } finally {
      if (mounted) setState(() => _badgeSubmitting = false);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _onlineLabelTimer?.cancel();
    _badgeCodeController.dispose();
    _badgeCodeFocus.dispose();
    super.dispose();
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
      subtitle:
          'ตั้งรหัส 4 หลักไว้กันคนอื่นแตะชื่อคุณเข้าใช้งาน — ข้ามได้ถ้าไม่ต้องการ',
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
      validate: (entered) async =>
          entered == firstPin ? null : 'รหัสไม่ตรงกัน ลองใหม่',
    );
    if (confirm == null || confirm.pin == null) {
      return; // cancelled — nothing saved
    }
    if (!mounted) return;
    try {
      await c.api.setEmployeePin(e.id, firstPin);
    } catch (err) {
      if (!mounted) return;
      c.toastMsg('ตั้งรหัส PIN ไม่สำเร็จ', c.errorMessage(err), ResultKind.err);
      return;
    }
    c.prefs.clearPinSkip(e.id);
    c.prefs.cachePinHash(e.id, firstPin);
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
          // The server just answered authoritatively — refresh (or don't)
          // the offline fallback to match, so a PIN changed elsewhere isn't
          // still accepted offline here after this device saw the change.
          if (ok) c.prefs.cachePinHash(e.id, entered);
          return ok ? null : 'รหัสไม่ถูกต้อง ลองใหม่';
        } catch (err) {
          // The server never actually answered (offline, timeout, gate
          // unreachable) — not the same as it rejecting the PIN. Fall back
          // to the last PIN it confirmed for this employee on this device
          // (see Prefs.verifyPinOffline) rather than stranding them.
          if (c.prefs.verifyPinOffline(e.id, entered)) return null;
          return 'ออฟไลน์ และยังไม่เคยยืนยันรหัสนี้บนเครื่องนี้ตอนออนไลน์มาก่อน';
        }
      },
    );
    if (result == null) return; // cancelled
    if (result.forgot) {
      await _forgotPin(e, null);
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
  ///
  /// The OTP request itself already ran inside the PIN sheet's `onForgot`
  /// (see [_verifyThenEnter]) — that's what keeps the sheet showing a loading
  /// state for the whole round trip instead of popping and leaving this
  /// screen idle while it waits. [sentTo] is whatever that request found.
  ///
  /// Step order is **OTP first**, then new-PIN → confirm. The operator taps
  /// "ลืมรหัส PIN?" expecting to land straight on the OTP entry they were
  /// just emailed about — not a "set a new PIN" screen that only reveals a
  /// wrong/expired code several taps later. `verifyPinReset(id, otp)` checks
  /// the code against what's on file without consuming it or touching the
  /// PIN, so a wrong code shows inline right here and the pad stays open for
  /// a retype; only a verified OTP is allowed through to the PIN screens.
  /// The actual PIN write still goes through `confirmPinReset(id, otp, pin)`
  /// at the end — the only call that touches the PIN — carrying the same OTP
  /// that was just verified.
  /// Forgot PIN, decided on the handheld with no one watching it from elsewhere.
  /// The employee's card is already identified; a supervisor who may reset PINs
  /// scans their own card here, then the employee sets the new PIN twice.
  Future<void> _forgotPin(Employee e, String? sentTo) async {
    if (!mounted) return;
    final c = context.read<AppController>();
    final supervisorCard = await _askSupervisorCard(e);
    if (supervisorCard == null || !mounted) return;

    final newPinResult = await showPinPad(
      context,
      title: 'ตั้งรหัส PIN ใหม่สำหรับ ${e.name}',
    );
    if (newPinResult == null || newPinResult.pin == null) return;
    final newPin = newPinResult.pin!;

    if (!mounted) return;
    var applied = false;
    final confirm = await showPinPad(
      context,
      title: 'ยืนยันรหัส PIN ใหม่อีกครั้ง',
      validate: (entered) async {
        if (entered != newPin) return 'รหัสไม่ตรงกัน ลองใหม่';
        try {
          await c.api.resetPinApproved(
            employeeCard: e.scanCode.isNotEmpty ? e.scanCode : e.id,
            supervisorCard: supervisorCard,
            pin: newPin,
          );
          applied = true;
          return null;
        } on ApiException catch (err) {
          return err.message.isEmpty ? 'รีเซ็ต PIN ไม่สำเร็จ ลองใหม่' : err.message;
        } catch (err) {
          return c.errorMessage(err);
        }
      },
    );
    if (confirm == null || !applied) return;

    c.prefs.clearPinSkip(e.id);
    c.prefs.cachePinHash(e.id, newPin);
    if (!mounted) return;
    c.toastMsg('ตั้งรหัส PIN ใหม่แล้ว', 'อนุมัติโดยหัวหน้าเวร', ResultKind.ok);
    final err = c.identifyAs(e);
    if (err != null) c.toastMsg(err, '', ResultKind.err);
  }

  /// Asks for a supervisor's card. The handheld's scanner types the barcode into
  /// the focused field, so the supervisor just scans their card. Returns null if
  /// cancelled.
  Future<String?> _askSupervisorCard(Employee e) async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('ให้หัวหน้าเวรยิงบัตรของตัวเอง'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('เพื่ออนุมัติการตั้ง PIN ใหม่ให้ ${e.name}'),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'บัตรหัวหน้า'),
              onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('ยกเลิก')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('ยืนยัน'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (result == null || result.isEmpty) return null;
    return result.toUpperCase();
  }

  /// Scanner-ready affordance becomes an editable employee-code input when
  /// tapped. The physical scanner is parked while typing so it cannot steal
  /// focus back from this field.
  Widget _scanPrompt(LocaleController loc, AppController c) {
    final ready = _typedEmployee(c) != null && !_badgeSubmitting;
    if (_manualBadgeOpen) {
      return TextField(
        key: const Key('manual-employee-code-input'),
        controller: _badgeCodeController,
        focusNode: _badgeCodeFocus,
        onTapOutside: (_) => _closeManualBadge(),
        textCapitalization: TextCapitalization.characters,
        textInputAction: TextInputAction.done,
        autocorrect: false,
        enableSuggestions: false,
        style: TextStyle(color: C.onHero, fontSize: 16),
        cursorColor: C.lime,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          hintText: loc.t('กรอกรหัสพนักงาน'),
          hintStyle: TextStyle(color: C.onHero.withValues(alpha: 0.55)),
          filled: true,
          fillColor: C.onHero.withValues(alpha: 0.08),
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(13),
            borderSide: BorderSide(color: C.onHero.withValues(alpha: 0.16)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(13),
            borderSide: BorderSide(color: C.lime, width: 1.5),
          ),
          suffixIcon: ready
              ? Semantics(
                  button: true,
                  label: loc.t('ยืนยันรหัสพนักงาน'),
                  child: IconButton(
                    key: const Key('submit-employee-code'),
                    onPressed: _submitTypedBadge,
                    icon: SvgPicture.asset(
                      'assets/icons/badge-submit.svg',
                      width: 22,
                      height: 22,
                    ),
                    style: IconButton.styleFrom(
                      backgroundColor: C.lime,
                      minimumSize: const Size(44, 44),
                    ),
                  ),
                )
              : null,
        ),
      );
    }
    return Semantics(
      button: true,
      label: loc.t('พิมพ์รหัสพนักงานแทน'),
      child: InkWell(
        key: const Key('open-employee-code-input'),
        onTap: _openManualBadge,
        borderRadius: BorderRadius.circular(13),
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          decoration: BoxDecoration(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: C.onHero.withValues(alpha: 0.16)),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.keyboard_alt_outlined,
                  size: 18, color: C.onHero.withValues(alpha: 0.7)),
              const SizedBox(width: 9),
              Flexible(
                child: Text(loc.t('พิมพ์รหัสพนักงานแทน'),
                    style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: C.onHero.withValues(alpha: 0.8))),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final top = MediaQuery.of(context).padding.top;
    final bottom = MediaQuery.of(context).padding.bottom;
    final people = c.employees;
    _syncOnlineLabel(c.onlineDisplay);

    // Header is a fixed sibling of the scrolling body now, not the first
    // child inside the same SingleChildScrollView — it used to scroll away
    // with everything else despite a comment here claiming otherwise. th/en
    // and light/dark are gone from it entirely (moved to Settings, which is
    // the one place they're meant to live) — this screen only needs to say
    // who's badging in and whether the terminal is configured/connected.
    return ScanCapture(
      enabled: !_manualBadgeOpen,
      onScan: _submitBadge,
      child: Column(
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(22, top + 26, 22, 12),
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
                // The label reflects both server reachability and the
                // operator's queue-mode choice. Tapping explicitly switches
                // online/offline; failed network requests are queued too.
                OnlineChip(
                  online: c.onlineDisplay,
                  onTap: c.onlineChipTap,
                  showLabel: !c.onlineDisplay || _showOnlineLabel,
                ),
              ],
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: EdgeInsets.only(bottom: bottom + 20),
              child: Column(
                children: [
                  // No more inline "เชื่อมต่อไม่ได้" banner routing straight to
                  // device setup — that page is for changing the connection, not
                  // the first thing an offline terminal should shove in front of
                  // an operator who just wants to badge in. The badge flow
                  // already works fully offline (see AppController.employees,
                  // Prefs.verifyPinOffline); connectivity is now just the small
                  // icon in the header, and it only ever escalates to
                  // "ตั้งค่าระบบ" if an operator deliberately taps it and a
                  // retry still fails.
                  _BadgePrompt(field: _scanPrompt(loc, c)),
                  if (!c.deviceConfigured && c.canConfigureDevice)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(22, 0, 22, 14),
                      child: OutlinedButton.icon(
                        onPressed: c.goDeviceSetup,
                        icon: const Icon(Icons.settings_outlined, size: 18),
                        label: Text(loc.t('ตั้งค่าเครื่อง')),
                      ),
                    ),
                  if (people.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        loc.t(c.connected
                            ? 'ยังไม่มีพนักงานในระบบ'
                            : 'รอเชื่อมต่อกับระบบหลักก่อน'),
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
                                style: TextStyle(
                                    fontSize: 12.5,
                                    color: C.muted,
                                    fontWeight: FontWeight.w600)),
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
            ),
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
              loc.t('เหนี่ยวไกยิงบัตรได้เลย'),
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w700,
                  color: C.onHero,
                  letterSpacing: -0.3),
            ),
            const SizedBox(height: 6),
            Text(
              loc.t('ทุกการยิงเข้า–ออกจะบันทึกในชื่อผู้ที่ยิงบัตร'),
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 12.5,
                  color: C.onHero.withValues(alpha: 0.62),
                  height: 1.4),
            ),
            const SizedBox(height: 16),
            field,
          ],
        ),
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
            border: Border.all(
                color: isLast ? C.limeBorder : C.border,
                width: isLast ? 1.5 : 1),
            boxShadow: [
              BoxShadow(
                  color: Colors.black.withValues(alpha: 0.04),
                  blurRadius: 2,
                  offset: const Offset(0, 1))
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration:
                    BoxDecoration(color: C.neutralBg, shape: BoxShape.circle),
                alignment: Alignment.center,
                child: Text(emp.initials,
                    style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: C.ink2)),
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
                        style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: C.ink)),
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
