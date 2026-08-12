import 'dart:async';
import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/employee.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../services/rfid_service.dart';
import '../services/sound_catalog.dart';
import '../services/theme_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/pin_pad.dart';

/// In-shift settings: what the operator can see and do without leaving their
/// session. Anything that changes what this terminal *is* — its address, its
/// service account, the gate it serves — lives in device setup instead, behind
/// [AppController.canConfigureDevice].
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final themeCtrl = context.watch<ThemeController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    // Hardware-debug tiles (raw RFID reads, the backend URL) are noise for a
    // regular operator and only worth showing to an admin — see
    // Employee.isAdmin. A device with no operator identified yet (emp ==
    // null) is treated the same as canConfigureDevice does elsewhere.
    final isAdminOrNull = c.emp == null || c.emp!.isAdmin;

    return AutoHideHeader(
      header: StickyHeader(
        onBack: c.backToHome,
        title: Text(loc.t('ตั้งค่า')),
        actions: [
          LangToggleButton(loc: loc),
          const SizedBox(width: 8),
          ThemeToggleButton(ctrl: themeCtrl)
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, 16, 16, bottom + 16),
              children: [
                Panel(
                  padding: const EdgeInsets.all(16),
                  radius: 18,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Caption(loc.t('การเชื่อมต่อระบบหลัก')),
                      const SizedBox(height: 12),
                      // Tappable only while actually disconnected — connected
                      // is nothing to act on. A tap first retries with
                      // whatever's already saved, and only walks into the
                      // server-address/service-account form if that still
                      // fails (see AppController.reconnectOrConfigure) — the
                      // PDA-is-on-Wi-Fi-but-server-unreachable case this exists
                      // for needs a new address typed in, not another silent
                      // retry.
                      InkWell(
                        onTap: c.connected ? null : c.reconnectOrConfigure,
                        borderRadius: BorderRadius.circular(12),
                        child: Row(
                          children: [
                            Container(
                              width: 11,
                              height: 11,
                              decoration: BoxDecoration(
                                color: c.connected ? C.lime : C.red,
                                shape: BoxShape.circle,
                                boxShadow: [
                                  BoxShadow(
                                      color: c.connected ? C.limeBg : C.redBg,
                                      spreadRadius: 3)
                                ],
                              ),
                            ),
                            const SizedBox(width: 11),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    c.connected
                                        ? loc.t('เชื่อมต่อกับ SmartTrace แล้ว')
                                        : (c.connError ??
                                            loc.t('ยังไม่พบข้อมูล')),
                                    style: const TextStyle(
                                        fontSize: 14.5,
                                        fontWeight: FontWeight.w600),
                                  ),
                                  Text(
                                    c.connected
                                        ? '${loc.t('พบ')} ${c.boxCount} ${loc.t('กล่องในฐานข้อมูล')}'
                                        : loc.t('แตะเพื่อเชื่อมต่อใหม่'),
                                    style:
                                        TextStyle(fontSize: 12, color: C.muted),
                                  ),
                                ],
                              ),
                            ),
                            if (!c.connected)
                              Icon(Icons.refresh, size: 18, color: C.muted),
                          ],
                        ),
                      ),
                      if (isAdminOrNull) ...[
                        const SizedBox(height: 10),
                        Text(c.prefs.baseUrl,
                            style: TextStyle(fontSize: 11.5, color: C.faint)),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                const _RfidPanel(),
                if (isAdminOrNull) ...[
                  const SizedBox(height: 10),
                  _tile(
                    icon: Icons.nfc,
                    title: loc.t('รับค่า RFID'),
                    sub: loc.t(
                        'อ่านแท็กสด ๆ แบบไม่ผูกกับกล่อง — ดูความเร็วอ่านได้ที่นี่'),
                    onTap: () => c.go(Screen.rfidInput),
                  ),
                ],
                const SizedBox(height: 16),
                if (c.canConfigureDevice)
                  _tile(
                    icon: Icons.router_outlined,
                    title: loc.t('ตั้งค่าเครื่อง'),
                    sub:
                        '${c.selWhName} · ${loc.t('ประตู')} ${c.gate} · ${loc.t('เซิร์ฟเวอร์ + บัญชีเครื่อง')}',
                    onTap: c.goDeviceSetup,
                  )
                else
                  _tile(
                    icon: Icons.lock_outline,
                    title: loc.t('ตั้งค่าเครื่อง'),
                    sub:
                        '${loc.t('เฉพาะหัวหน้างาน — เครื่องนี้ประจำ')} ${c.selWhName} ${loc.t('ประตู')} ${c.gate}',
                    onTap: null,
                  ),
                if (c.emp != null) ...[
                  const SizedBox(height: 10),
                  _tile(
                    icon: Icons.pin_outlined,
                    title: loc.t('รหัส PIN ส่วนตัว'),
                    sub: c.emp!.hasPin
                        ? loc.t('ตั้งไว้แล้ว — แตะเพื่อเปลี่ยนรหัส')
                        : loc.t(
                            'ยังไม่ได้ตั้ง — แตะเพื่อตั้งรหัสกันคนอื่นแตะชื่อคุณ'),
                    onTap: () => _setupPin(context, c),
                  ),
                  const SizedBox(height: 10),
                  _tile(
                    icon: Icons.swap_horiz,
                    title: loc.t('เปลี่ยนคน / จบงาน'),
                    sub: loc.t('กลับไปหน้ายิงบัตร'),
                    danger: true,
                    onTap: () => c.lock(),
                  ),
                ],
                const SizedBox(height: 18),
                Center(
                  child: Text(
                    'SmartTrace PDA · v1.1\nFlutter + Zebra RFIDAPI3 · ${loc.t('เชื่อมกับ SmartTrace backend')}',
                    textAlign: TextAlign.center,
                    style:
                        TextStyle(fontSize: 11.5, color: C.faint, height: 1.5),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _tile({
    required IconData icon,
    required String title,
    required String sub,
    VoidCallback? onTap,
    bool danger = false,
  }) {
    final enabled = onTap != null;
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
              border: Border.all(color: C.border)),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: danger ? C.redBg : C.neutralBg,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon,
                    size: 21,
                    color: !enabled
                        ? C.faint
                        : danger
                            ? C.red
                            : C.ink2),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title,
                        style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            color: !enabled
                                ? C.faint
                                : danger
                                    ? C.red
                                    : C.ink)),
                    Text(sub,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12.5, color: C.muted)),
                  ],
                ),
              ),
              if (enabled)
                Icon(Icons.chevron_right, color: C.chevron, size: 20),
            ],
          ),
        ),
      ),
    );
  }

  /// Lets an already-signed-in operator set (first time) or change (already
  /// has one) their own PIN. A change now demands the *old* PIN first —
  /// being signed into the session proves who's holding the device, not
  /// that whoever's tapping this tile right now is that person; a PIN
  /// exists specifically to stop someone else changing it out from under
  /// them. First-time setup (no PIN on file yet) skips straight to picking
  /// one, same as before. "ลืมรหัส?" on that old-PIN check reuses the same
  /// email-OTP reset login_screen.dart's badge flow already has.
  Future<void> _setupPin(BuildContext context, AppController c) async {
    final e = c.emp;
    if (e == null) return;
    final loc = context.read<LocaleController>();

    if (e.hasPin) {
      String? otpSentTo;
      final verify = await showPinPad(
        context,
        title: '${loc.t('ใส่รหัส PIN เดิมของ')} ${e.name}',
        subtitle: loc.t('ยืนยันตัวตนก่อนตั้งรหัสใหม่'),
        showForgot: true,
        validate: (entered) async {
          try {
            final ok = await c.api.verifyEmployeePin(e.id, entered);
            if (ok) c.prefs.cachePinHash(e.id, entered);
            return ok ? null : loc.t('รหัสไม่ถูกต้อง ลองใหม่');
          } catch (err) {
            if (c.prefs.verifyPinOffline(e.id, entered)) return null;
            return loc.t(
                'ออฟไลน์ และยังไม่เคยยืนยันรหัสนี้บนเครื่องนี้ตอนออนไลน์มาก่อน');
          }
        },
        onForgot: () async {
          try {
            final req = await c.api.requestPinReset(e.id);
            otpSentTo = req['sentTo']?.toString();
            return null;
          } catch (err) {
            return err is ApiException
                ? err.message
                : loc.t('ขอรหัส OTP ไม่สำเร็จ');
          }
        },
      );
      if (verify == null) return; // cancelled
      if (verify.forgot) {
        await _forgotPinFlow(context, c, e, otpSentTo);
        return;
      }
      if (verify.pin == null) return;
      if (!context.mounted) return;
    }

    final first = await showPinPad(
      context,
      title: e.hasPin
          ? '${loc.t('ตั้งรหัส PIN ใหม่สำหรับ')} ${e.name}'
          : '${loc.t('ตั้งรหัส PIN สำหรับ')} ${e.name}',
      subtitle: loc.t('ตั้งรหัส 4 หลักไว้กันคนอื่นแตะชื่อคุณเข้าใช้งาน'),
    );
    if (first == null || first.pin == null) return;
    if (!context.mounted) return;
    final confirm = await showPinPad(
      context,
      title: loc.t('ยืนยันรหัส PIN อีกครั้ง'),
      subtitle: loc.t('พิมพ์รหัส 4 หลักเดิมอีกครั้งเพื่อยืนยัน'),
      validate: (entered) async =>
          entered == first.pin ? null : loc.t('รหัสไม่ตรงกัน ลองใหม่'),
    );
    if (confirm == null || confirm.pin == null) {
      return; // cancelled — nothing saved
    }
    if (!context.mounted) return;
    try {
      await c.api.setEmployeePin(e.id, first.pin!);
    } catch (err) {
      if (!context.mounted) return;
      c.toastMsg(loc.t('ตั้งรหัส PIN ไม่สำเร็จ'), '$err', ResultKind.err);
      return;
    }
    c.prefs.clearPinSkip(e.id);
    c.prefs.cachePinHash(e.id, first.pin!);
    c.toastMsg(loc.t('ตั้งรหัส PIN แล้ว'), '', ResultKind.ok);
  }

  /// Same email-OTP reset login_screen.dart's badge flow uses (see its
  /// _forgotPin) — duplicated rather than shared across the two screens'
  /// otherwise-unrelated widget trees, since a fully-independent flow here
  /// keeps this screen's PIN change working even if the badge screen's PIN
  /// pad ever changes shape.
  Future<void> _forgotPinFlow(
      BuildContext context, AppController c, Employee e, String? sentTo) async {
    final loc = context.read<LocaleController>();
    c.toastMsg(
      loc.t('ส่งรหัส OTP แล้ว'),
      sentTo != null
          ? '${loc.t('ส่งไปที่อีเมล')} $sentTo ${loc.t('แล้ว — กรอกรหัส 6 หลักด้านล่าง')}'
          : loc.t('เช็คอีเมลของคุณแล้วกรอกรหัส 6 หลักด้านล่าง'),
      ResultKind.info,
    );
    if (!context.mounted) return;
    // OTP first — see login_screen.dart's _forgotPin for the full reasoning:
    // verifyPinReset checks the code without consuming it or touching the
    // PIN, so a wrong/expired OTP is caught right here instead of after the
    // operator has already typed a new PIN twice. The actual write still
    // goes through confirmPinReset at the end, carrying this verified OTP.
    final otpResult = await showPinPad(
      context,
      title: loc.t('กรอกรหัส OTP'),
      subtitle: sentTo != null
          ? '${loc.t('ส่งไปที่')} $sentTo ${loc.t('(มีอายุ 5 นาที)')}'
          : loc.t('รหัส 6 หลักที่ส่งไปทางอีเมล (มีอายุ 5 นาที)'),
      length: 6,
      validate: (otp) async {
        try {
          await c.api.verifyPinReset(e.id, otp);
          return null;
        } on ApiException catch (err) {
          return err.message.isEmpty
              ? loc.t('รหัส OTP ไม่ถูกต้องหรือหมดอายุ')
              : err.message;
        } catch (err) {
          return c.errorMessage(err);
        }
      },
      // See login_screen.dart's _forgotPin for the same resend wiring — kept
      // identical (3-minute client-side cooldown, server's own rate limiter
      // does the rest) so the two OTP screens behave the same way.
      resendCooldown: const Duration(minutes: 3),
      onResend: () async {
        try {
          final req = await c.api.requestPinReset(e.id);
          sentTo = req['sentTo']?.toString();
          return null;
        } catch (err) {
          return err is ApiException ? err.message : c.errorMessage(err);
        }
      },
    );
    if (otpResult == null || otpResult.pin == null) return;
    final verifiedOtp = otpResult.pin!;

    if (!context.mounted) return;
    final newPinResult = await showPinPad(context,
        title: '${loc.t('ตั้งรหัส PIN ใหม่สำหรับ')} ${e.name}');
    if (newPinResult == null || newPinResult.pin == null) return;
    final newPin = newPinResult.pin!;

    if (!context.mounted) return;
    var applied = false;
    final confirm = await showPinPad(
      context,
      title: loc.t('ยืนยันรหัส PIN ใหม่อีกครั้ง'),
      validate: (entered) async {
        if (entered != newPin) return loc.t('รหัสไม่ตรงกัน ลองใหม่');
        try {
          await c.api.confirmPinReset(e.id, otp: verifiedOtp, pin: newPin);
          applied = true;
          return null;
        } on ApiException catch (err) {
          return err.message.isEmpty
              ? loc.t('รหัส OTP ไม่ถูกต้องหรือหมดอายุ')
              : err.message;
        } catch (err) {
          return c.errorMessage(err);
        }
      },
    );
    if (confirm == null || !applied) return;

    c.prefs.clearPinSkip(e.id);
    c.prefs.cachePinHash(e.id, newPin);
    if (!context.mounted) return;
    c.toastMsg(loc.t('ตั้งรหัส PIN ใหม่แล้ว'), '', ResultKind.ok);
  }
}

/// Reader diagnostics.
///
/// A coloured dot is no use the first time a terminal is unboxed at a gate: if
/// nothing reads, the operator needs to know whether the reader was even found,
/// over which transport, at what power, in which region — and what the last
/// failure actually said. This panel answers all of that, and keeps a running
/// tag count so a five-second trigger pull is a conclusive test.
class _RfidPanel extends StatefulWidget {
  const _RfidPanel();

  @override
  State<_RfidPanel> createState() => _RfidPanelState();
}

class _RfidPanelState extends State<_RfidPanel> {
  Map<String, dynamic> _d = const {};
  Timer? _poll;

  /// Raw power index the slider is showing, once the operator has actually
  /// dragged it this session. Null means "not touched yet" — the slider
  /// falls back to whatever the reader itself last reported.
  int? _rangeIndex;

  /// True while either the on-screen "กดค้างเพื่อทดสอบยิง" button OR the
  /// physical trigger is actually firing — the on-screen button used to be
  /// the only thing that ever set this, so pulling the *physical* trigger
  /// while standing on this screen (now allowed, see AppController.
  /// _onReaderTrigger's Screen.settings branch) span up an inventory sweep
  /// the button itself never found out about: it just sat there reading
  /// "กดค้างเพื่อทดสอบยิง" the whole time despite the antenna actually
  /// running. [_triggerSub] below is what keeps the two in sync.
  bool _testFiring = false;
  StreamSubscription<bool>? _triggerSub;

  /// Distinct EPCs seen during the current test fire, in first-seen order,
  /// each with how many times it has come back. A held trigger reads the
  /// same tag dozens of times a second — the fanned card stack this used to
  /// back tried to show every one of those as its own card and just became
  /// an unreadable pile the moment more than two or three tags were in
  /// range. A count is what a repeat read actually is. Cleared at the start
  /// of every new test so an old sweep's tags don't linger into the next.
  final LinkedHashMap<String, int> _liveFound = LinkedHashMap();
  StreamSubscription<List<RfidTagRead>>? _tagSub;

  @override
  void initState() {
    super.initState();
    _refresh();
    // The tag counter is only useful if it moves while the trigger is held.
    // Low power mode widens this — a diagnostics call every 2s adds up over
    // a shift, and this screen isn't the one place a slow counter matters.
    final lowPower = context.read<AppController>().lowPowerMode;
    _poll =
        Timer.periodic(Duration(seconds: lowPower ? 5 : 2), (_) => _refresh());
    final rfid = context.read<AppController>().rfid;
    _triggerSub = rfid.triggers.listen((pressed) {
      if (!mounted) return;
      if (pressed) {
        setState(() {
          _testFiring = true;
          _liveFound.clear();
        });
        _testPoll?.cancel();
        _testPoll = Timer.periodic(
            const Duration(milliseconds: 200), (_) => _refresh());
      } else {
        setState(() => _testFiring = false);
        _testPoll?.cancel();
        _testPoll = null;
        _refresh();
      }
    });
    _tagSub = rfid.tagBatches.listen((batch) {
      if (!_testFiring) return;
      final epcs = batch.map((r) => r.epc).where((e) => e.isNotEmpty);
      if (epcs.isEmpty) return;
      setState(() {
        for (final epc in epcs) {
          // Stays in the position it was first seen — bumping a repeat to
          // the top would make the list reorder under the operator's thumb
          // on every re-read of whichever tag is closest to the antenna.
          _liveFound[epc] = (_liveFound[epc] ?? 0) + 1;
        }
      });
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _testPoll?.cancel();
    _triggerSub?.cancel();
    _tagSub?.cancel();
    // A stray finger-up outside the button (or navigating away mid-press)
    // must not leave the reader sweeping in the background.
    if (_testFiring) context.read<AppController>().rfid.stopInventory();
    super.dispose();
  }

  /// Runs only while the hold-to-test button is actually held — the
  /// background [_poll] above is deliberately slow (2-5s) to keep a
  /// diagnostics call from adding up over a whole shift, but that same
  /// slowness made a brief test hold look broken: release the button before
  /// the next slow tick lands and the tag counter never visibly moved at
  /// all. A tight poll only for the few seconds a test is actually running
  /// costs nothing over a shift and makes the counter track the hold in
  /// real time.
  Timer? _testPoll;

  Future<void> _startTest(AppController c) async {
    if (_testFiring) return;
    setState(() {
      _testFiring = true;
      _liveFound.clear();
    });
    await c.rfid.startInventory();
    _testPoll?.cancel();
    _testPoll =
        Timer.periodic(const Duration(milliseconds: 200), (_) => _refresh());
  }

  Future<void> _stopTest(AppController c) async {
    if (!_testFiring) return;
    setState(() => _testFiring = false);
    _testPoll?.cancel();
    _testPoll = null;
    await c.rfid.stopInventory();
    await _refresh();
  }

  Future<void> _refresh() async {
    final d = await context.read<AppController>().rfid.diagnostics();
    if (mounted) setState(() => _d = d);
  }

  static Color _colorFor(RfidState s) {
    switch (s) {
      case RfidState.connected:
        return C.lime;
      case RfidState.connecting:
        return C.orange;
      case RfidState.error:
        return C.red;
      default:
        return C.border2;
    }
  }

  String _label(AppController c, LocaleController loc) {
    if (!c.rfid.supported) {
      return loc.t('ใช้ได้เฉพาะบนเครื่อง Android ที่มีเครื่องอ่าน Zebra');
    }
    switch (c.rfidStatus.state) {
      case RfidState.connected:
        return loc.t('เชื่อมต่อเครื่องอ่านแล้ว');
      case RfidState.connecting:
        return loc.t('กำลังเชื่อมต่อ…');
      case RfidState.error:
        return loc.t('เชื่อมต่อไม่สำเร็จ');
      case RfidState.disconnected:
        return loc.t('ตัดการเชื่อมต่อ');
      case RfidState.idle:
        return loc.t('ยังไม่ได้เชื่อมต่อ');
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final power = _d['powerIndex'] == null
        ? null
        : '${_d['powerIndex']} / ${_d['powerMaxIndex'] ?? '-'}'
            '${_d['powerRaw'] != null ? '  (${_d['powerRaw']})' : ''}';

    return Panel(
      padding: const EdgeInsets.all(16),
      radius: 18,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Caption(loc.t('เครื่องอ่าน RFID (Zebra)')),
          const SizedBox(height: 12),
          Row(
            children: [
              Container(
                width: 11,
                height: 11,
                decoration: BoxDecoration(
                    color: _colorFor(c.rfidStatus.state),
                    shape: BoxShape.circle),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Text(_label(c, loc),
                    style: const TextStyle(
                        fontSize: 14.5, fontWeight: FontWeight.w600)),
              ),
              OutlinedButton(
                onPressed: () async {
                  await c.rfid.connect();
                  await _refresh();
                },
                style: OutlinedButton.styleFrom(
                  foregroundColor: C.ink,
                  side: BorderSide(color: C.border2),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(11)),
                ),
                child: Text(loc.t('เชื่อมต่อใหม่')),
              ),
            ],
          ),
          if (c.rfidStatus.message.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(c.rfidStatus.message,
                  style: TextStyle(fontSize: 12, color: C.muted)),
            ),
          if (c.rfid.supported) ...[
            const SizedBox(height: 14),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            Text(loc.t('ระยะยิงแท็ก'),
                style: const TextStyle(
                    fontSize: 12.5, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            // The slider needs the reader's own max index to cover every
            // step it actually has (see RfidService.setPowerIndex) — that
            // number only exists once the reader has answered a diagnostics
            // call, so there's honestly nothing precise to show before then.
            if (_d['powerMaxIndex'] is int) ...[
              Builder(builder: (context) {
                final maxIdx = _d['powerMaxIndex'] as int;
                final current =
                    (_rangeIndex ?? (_d['powerIndex'] as int?) ?? maxIdx)
                        .clamp(0, maxIdx);
                return _RangePicker(
                  value: current,
                  max: maxIdx,
                  onChanged: (v) {
                    setState(() => _rangeIndex = v);
                    // Percent is still what's persisted (and what
                    // AppController re-applies on the next connect, see
                    // rfid.setPowerPercent) — it's the one unit that still
                    // means something if this device is swapped for a
                    // reader with a different index range.
                    c.prefs.rfidPowerPercent =
                        maxIdx == 0 ? 100 : ((v / maxIdx) * 100).round();
                    c.rfid.setPowerIndex(v);
                  },
                );
              }),
              const SizedBox(height: 12),
              // Press-and-hold does the same thing the physical trigger
              // does — starts/stops inventory — so a range just dragged on
              // the slider can be checked immediately without setting the
              // handheld down to reach for the gun.
              //
              // Listener + raw pointer events, not GestureDetector's
              // onTapDown/onTapUp/onTapCancel: this button sits inside the
              // Settings ListView, and a tap-based recognizer here competes
              // in the same gesture arena as the Scrollable's own drag
              // recognizer — holding a finger down long enough to matter is
              // exactly what a scroll gesture also looks like at first,
              // which was cancelling the hold (onTapCancel firing) almost
              // immediately and making the button look unresponsive. Raw
              // pointer events don't participate in that arena at all.
              Listener(
                onPointerDown: (_) => _startTest(c),
                onPointerUp: (_) => _stopTest(c),
                onPointerCancel: (_) => _stopTest(c),
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 13),
                  decoration: BoxDecoration(
                    color: _testFiring ? C.limeBg : C.neutralBg,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                        color: _testFiring ? C.limeBorder : C.border2),
                  ),
                  alignment: Alignment.center,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.wifi_tethering,
                          size: 17, color: _testFiring ? C.limeDeep : C.ink2),
                      const SizedBox(width: 8),
                      Text(
                          loc.t(_testFiring
                              ? 'กำลังยิงทดสอบ… ปล่อยนิ้วเพื่อหยุด'
                              : 'กดค้างเพื่อทดสอบยิง'),
                          style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                              color: _testFiring ? C.limeDeep : C.ink2)),
                    ],
                  ),
                ),
              ),
              if (_liveFound.isNotEmpty) ...[
                const SizedBox(height: 14),
                Text(
                  '${loc.t('เจอ')} ${_liveFound.length} ${loc.t('แท็ก')}',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: C.muted),
                ),
                const SizedBox(height: 8),
                _FoundTagList(counts: _liveFound),
              ],
            ] else
              Text(
                loc.t(
                    'เชื่อมต่อเครื่องอ่านก่อน เพื่อปรับระยะยิงแบบละเอียดเต็มสเปกของเครื่องนี้'),
                style: TextStyle(fontSize: 12, color: C.faint, height: 1.4),
              ),
            const SizedBox(height: 14),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: Text(loc.t('กรองสัญญาณอ่อน (RSSI)'),
                      style: const TextStyle(
                          fontSize: 12.5, fontWeight: FontWeight.w700)),
                ),
                Switch(
                  value: c.prefs.rfidMinRssi != null,
                  onChanged: (on) {
                    setState(() {
                      // -70 dBm: matches the "ไกล" boundary RfidLocateScreen
                      // already uses as its own far-signal cutoff — a
                      // reasonable first guess for "this is a stray read
                      // from the next pallet over", tunable from here.
                      c.prefs.rfidMinRssi = on ? -70 : null;
                    });
                  },
                  activeThumbColor: C.lime,
                ),
              ],
            ),
            Text(
              loc.t(
                  'ตัดทิ้งแท็กที่อ่านได้อ่อนกว่าค่าที่ตั้ง — กันอ่านทะลุไปโดนพาเลทข้างๆ'),
              style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.4),
            ),
            if (c.prefs.rfidMinRssi != null) ...[
              const SizedBox(height: 10),
              _RssiPicker(
                value: c.prefs.rfidMinRssi!,
                onChanged: (v) => setState(() => c.prefs.rfidMinRssi = v),
              ),
            ],
            const SizedBox(height: 14),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            Text(loc.t('เสียงเมื่อเจอแท็ก RFID'),
                style: const TextStyle(
                    fontSize: 12.5, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(
              loc.t('แตะเพื่อฟังตัวอย่างแล้วเลือกทันที'),
              style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.4),
            ),
            const SizedBox(height: 10),
            _SoundRow(
              label: loc.t('เสียงตอนอ่าน RFID'),
              soundId: c.prefs.rfidSoundId,
              onTap: () => showSoundPickerSheet(
                context,
                title: loc.t('เสียงตอนอ่าน RFID'),
                currentId: c.prefs.rfidSoundId,
                onPreview: c.rfid.playSound,
                onSelect: c.setRfidSoundId,
              ),
            ),
            const SizedBox(height: 10),
            _VolumeRow(
              value: c.prefs.rfidSoundVolume,
              onChanged: (v) => c.setRfidSoundVolume(v),
            ),
          ],
          if (!c.rfid.supported)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                loc.t(
                    'บนเบราว์เซอร์/เดสก์ท็อปจะไม่มีเครื่องอ่าน — ใช้ช่องพิมพ์รหัสแทนได้ '
                    'รายละเอียดด้านล่างจะขึ้นเมื่อรันบนเครื่องจริง'),
                style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.45),
              ),
            ),
          if (_d.isNotEmpty) ...[
            const SizedBox(height: 14),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            _row(loc.t('รุ่นเครื่องอ่าน'), _d['model']),
            _row(loc.t('ชื่ออุปกรณ์'), _d['host']),
            _row(loc.t('หมายเลขเครื่อง'), _d['serial']),
            _row(loc.t('เฟิร์มแวร์'), _d['firmware']),
            _row(loc.t('ภูมิภาค (Region)'), _d['region']),
            _row(loc.t('ช่องทางเชื่อมต่อ'), _d['transport']),
            _row(loc.t('กำลังส่ง (index)'), power),
            const SizedBox(height: 10),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            _row(loc.t('แท็กที่อ่านได้สะสม'), '${_d['tagCount'] ?? 0}'),
            _row(loc.t('EPC ล่าสุด'), _d['lastEpc']),
            _row(loc.t('RSSI ล่าสุด'), _d['lastRssi']?.toString()),
            if (_d['lastError'] != null) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: C.redBg,
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Text('${loc.t('ข้อผิดพลาดล่าสุด')}: ${_d['lastError']}',
                    style: TextStyle(fontSize: 12, color: C.red, height: 1.4)),
              ),
            ],
            const SizedBox(height: 10),
            Text(
              loc.t(
                  'ทดสอบ: เหนี่ยวไกค้างไว้ 5 วินาทีใกล้กล่องที่ติดแท็ก — ถ้าตัวเลข '
                  '"แท็กที่อ่านได้สะสม" เดินขึ้น แปลว่าเครื่องอ่านทำงานครบวงจรแล้ว'),
              style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.45),
            ),
          ],
        ],
      ),
    );
  }

  Widget _row(String k, Object? v) {
    final text = (v == null || v.toString().isEmpty) ? '—' : v.toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 132,
            child: Text(k, style: TextStyle(fontSize: 12.5, color: C.muted)),
          ),
          Expanded(
            child: Text(text,
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: text == '—' ? C.faint : C.ink)),
          ),
        ],
      ),
    );
  }
}

/// Every distinct EPC found during a test fire, one row per tag with a
/// count badge — a held trigger reads the same tag dozens of times a
/// second, and that repeat is real information (signal is reaching it,
/// reliably) that a flat list of one-off cards used to just discard by
/// drawing another identical card on top.
class _FoundTagList extends StatelessWidget {
  final LinkedHashMap<String, int> counts; // first-seen order
  const _FoundTagList({required this.counts});

  @override
  Widget build(BuildContext context) {
    final entries = counts.entries.toList();
    return Column(
      children: [
        for (final e in entries) ...[
          if (e != entries.first) const SizedBox(height: 6),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: C.surface,
              borderRadius: BorderRadius.circular(11),
              border: Border.all(color: C.border),
            ),
            child: Row(
              children: [
                Icon(Icons.nfc, size: 14, color: C.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(e.key,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 12,
                          fontFamily: 'monospace',
                          fontWeight: FontWeight.w700)),
                ),
                const SizedBox(width: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: C.limeBg,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text('×${e.value}',
                      style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w800,
                          color: C.limeDeep,
                          fontFeatures: const [FontFeature.tabularFigures()])),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

/// Minimum-RSSI slider for the stray-read filter (see
/// AppController._onReaderBatch / Prefs.rfidMinRssi) — -95 dBm (accept
/// almost anything) to -25 dBm (only a tag right up against the antenna).
/// Raw dBm, not a percent: this is compared directly against what the
/// reader reports per read, so the number here has to mean the same thing.
class _RssiPicker extends StatelessWidget {
  static const _min = -95.0;
  static const _max = -25.0;

  final int value;
  final ValueChanged<int> onChanged;
  const _RssiPicker({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocaleController>();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
                loc.t(value <= -80
                    ? 'หลวม · รับเกือบทุกแท็ก'
                    : value <= -55
                        ? 'ปานกลาง'
                        : 'เข้ม · เฉพาะแท็กใกล้มาก'),
                style: TextStyle(
                    fontSize: 12.5,
                    color: C.muted,
                    fontWeight: FontWeight.w600)),
            Text('$value dBm',
                style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w800,
                    color: C.ink,
                    fontFeatures: const [FontFeature.tabularFigures()])),
          ],
        ),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            trackHeight: 5,
            activeTrackColor: C.ink,
            inactiveTrackColor: C.neutralBg2,
            thumbColor: C.ink,
            overlayColor: C.ink.withValues(alpha: 0.12),
            thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 10),
          ),
          child: Slider(
            value: value.toDouble().clamp(_min, _max),
            min: _min,
            max: _max,
            onChanged: (v) => onChanged(v.round()),
          ),
        ),
      ],
    );
  }
}

/// Fine-grained transmit-power slider — every raw index the reader actually
/// has, 0 through [max]. Used to be three fixed presets (ใกล้/ปานกลาง/ไกล),
/// then a 0-100% slider; a percent still only reaches ~101 of the reader's
/// real steps because its index range runs well past 100 on this hardware.
/// [RfidReaderController.setPowerIndex] sets that exact index directly —
/// no percent math, no skipped steps.
class _RangePicker extends StatelessWidget {
  final int value;
  final int max;
  final ValueChanged<int> onChanged;
  const _RangePicker(
      {required this.value, required this.max, required this.onChanged});

  /// The index range varies by reader model, so classification has to be
  /// relative to [max] — this is the same ใกล้/ปานกลาง/ไกล vocabulary the
  /// original preset picker used, now derived from position instead of
  /// snapped to it.
  String _label(int v, LocaleController loc) {
    if (max <= 0) return '';
    final pct = v / max * 100;
    if (pct <= 40) return loc.t('ใกล้ · ~30 ซม.');
    if (pct <= 75) return loc.t('ปานกลาง · ~1-2 ม.');
    return loc.t('ไกล · สุดกำลังเครื่อง');
  }

  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocaleController>();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(_label(value, loc),
                style: TextStyle(
                    fontSize: 12.5,
                    color: C.muted,
                    fontWeight: FontWeight.w600)),
            Text('$value / $max',
                style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w800,
                    color: C.ink,
                    fontFeatures: const [FontFeature.tabularFigures()])),
          ],
        ),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            trackHeight: 5,
            activeTrackColor: C.ink,
            inactiveTrackColor: C.neutralBg2,
            thumbColor: C.ink,
            overlayColor: C.ink.withValues(alpha: 0.12),
            thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 10),
          ),
          child: Slider(
            value: value.toDouble().clamp(0, max.toDouble()),
            min: 0,
            max: max <= 0 ? 1 : max.toDouble(),
            // No `divisions` — a stepped slider snaps to fixed ticks, which
            // is the same "only a few presets" limitation this replaced.
            // Continuous drag reports every index the reader has, exactly
            // as [RfidReaderController.setPowerIndex] expects it.
            onChanged: max <= 0 ? null : (v) => onChanged(v.round()),
          ),
        ),
        // Both work, not one or the other: drag the slider to get in the
        // ballpark fast, then nudge ±1 to land on an exact index — a slider
        // alone can't reliably hit a specific single-digit value on a
        // 200+-step range with a thumb sized for a fingertip.
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _stepButton(
                Icons.remove, value > 0 ? () => onChanged(value - 1) : null),
            const SizedBox(width: 14),
            _stepButton(
                Icons.add, value < max ? () => onChanged(value + 1) : null),
          ],
        ),
      ],
    );
  }

  Widget _stepButton(IconData icon, VoidCallback? onTap) {
    return Material(
      color: onTap == null ? C.neutralBg2 : C.neutralBg,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
          width: 40,
          height: 40,
          child: Icon(icon, size: 19, color: onTap == null ? C.faint : C.ink2),
        ),
      ),
    );
  }
}

/// One "เสียงตอน…" row — current sound's name, tap to open the picker.
class _SoundRow extends StatelessWidget {
  final String label;
  final String soundId;
  final VoidCallback onTap;
  const _SoundRow(
      {required this.label, required this.soundId, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
        decoration: BoxDecoration(
          color: C.neutralBg,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: C.border2),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label,
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: C.ink)),
                  const SizedBox(height: 2),
                  Text(soundNameFor(soundId),
                      style: TextStyle(fontSize: 12, color: C.muted)),
                ],
              ),
            ),
            Icon(Icons.chevron_right, size: 19, color: C.chevron),
          ],
        ),
      ),
    );
  }
}

/// Slider for the RFID detection sound's playback level — a plain 0-100%
/// drag, previewing live so dragging past "too quiet to hear on a noisy
/// floor" or "startles everyone" is obvious before letting go.
class _VolumeRow extends StatelessWidget {
  final double value;
  final ValueChanged<double> onChanged;
  const _VolumeRow({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
      decoration: BoxDecoration(
        color: C.neutralBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: C.border2),
      ),
      child: Row(
        children: [
          Icon(value == 0 ? Icons.volume_off : Icons.volume_up,
              size: 18, color: C.ink2),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 3,
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 8),
                overlayShape: const RoundSliderOverlayShape(overlayRadius: 16),
              ),
              child: Slider(
                value: value,
                min: 0,
                max: 1,
                activeColor: C.ink,
                inactiveColor: C.border2,
                onChanged: onChanged,
              ),
            ),
          ),
          SizedBox(
            width: 34,
            child: Text('${(value * 100).round()}%',
                textAlign: TextAlign.right,
                style: TextStyle(
                    fontSize: 12, fontWeight: FontWeight.w600, color: C.muted)),
          ),
        ],
      ),
    );
  }
}

/// Modal sound picker — every entry in [kSoundCatalog], tap one and it both
/// plays immediately (via [onPreview]) and becomes the selection (via
/// [onSelect]) in the same action. No separate "confirm" step: "เวลาเลือก
/// ปุ๊บก็เล่นเสียงเลย" is a single tap, not preview-then-commit.
Future<void> showSoundPickerSheet(
  BuildContext context, {
  required String title,
  required String currentId,
  required ValueChanged<String> onPreview,
  required ValueChanged<String> onSelect,
}) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (sheetContext) => _SoundPickerSheet(
      title: title,
      currentId: currentId,
      onPreview: onPreview,
      onSelect: onSelect,
    ),
  );
}

class _SoundPickerSheet extends StatefulWidget {
  final String title;
  final String currentId;
  final ValueChanged<String> onPreview;
  final ValueChanged<String> onSelect;
  const _SoundPickerSheet({
    required this.title,
    required this.currentId,
    required this.onPreview,
    required this.onSelect,
  });

  @override
  State<_SoundPickerSheet> createState() => _SoundPickerSheetState();
}

class _SoundPickerSheetState extends State<_SoundPickerSheet> {
  late String _selected = widget.currentId;

  void _pick(String id) {
    setState(() => _selected = id);
    widget.onPreview(id);
    widget.onSelect(id);
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).padding.bottom;
    return Container(
      decoration: BoxDecoration(
        color: C.bg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(widget.title,
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w700)),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                padding: EdgeInsets.fromLTRB(10, 0, 10, bottom + 12),
                itemCount: kSoundCatalog.length,
                itemBuilder: (context, i) {
                  final opt = kSoundCatalog[i];
                  final selected = opt.id == _selected;
                  return InkWell(
                    onTap: () => _pick(opt.id),
                    borderRadius: BorderRadius.circular(12),
                    child: Container(
                      margin: const EdgeInsets.symmetric(
                          vertical: 3, horizontal: 6),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 13),
                      decoration: BoxDecoration(
                        color: selected ? C.limeBg : Colors.transparent,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                            color:
                                selected ? C.limeBorder : Colors.transparent),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            selected
                                ? Icons.volume_up
                                : Icons.volume_up_outlined,
                            size: 19,
                            color: selected ? C.limeDeep : C.ink2,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              opt.name,
                              style: TextStyle(
                                fontSize: 14,
                                fontWeight: selected
                                    ? FontWeight.w800
                                    : FontWeight.w600,
                                color: selected ? C.limeDeep : C.ink,
                              ),
                            ),
                          ),
                          if (selected)
                            Icon(Icons.check, size: 18, color: C.limeDeep),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
