import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/employee.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../services/rfid_service.dart';
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

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: const Text('ตั้งค่า'),
          actions: [LangToggleButton(loc: loc), const SizedBox(width: 8), ThemeToggleButton(ctrl: themeCtrl)],
        ),
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
                    const Caption('การเชื่อมต่อระบบหลัก'),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Container(
                          width: 11,
                          height: 11,
                          decoration: BoxDecoration(
                            color: c.connected ? C.lime : C.red,
                            shape: BoxShape.circle,
                            boxShadow: [
                              BoxShadow(color: c.connected ? C.limeBg : C.redBg, spreadRadius: 3)
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
                                c.connected ? 'เชื่อมต่อกับ BoxTrace แล้ว' : (c.connError ?? 'ยังไม่พบข้อมูล'),
                                style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                              ),
                              Text('พบ ${c.boxCount} กล่องในฐานข้อมูล',
                                  style: TextStyle(fontSize: 12, color: C.muted)),
                            ],
                          ),
                        ),
                      ],
                    ),
                    if (isAdminOrNull) ...[
                      const SizedBox(height: 10),
                      Text(c.prefs.baseUrl, style: TextStyle(fontSize: 11.5, color: C.faint)),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Panel(
                padding: const EdgeInsets.all(16),
                radius: 18,
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Text('โหมดประหยัดพลังงาน',
                              style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700)),
                          const SizedBox(height: 3),
                          Text('ลดกราฟฟิกและความถี่รีเฟรช เพื่อความเร็วบนเครื่อง',
                              style: TextStyle(fontSize: 12, color: C.muted, height: 1.4)),
                        ],
                      ),
                    ),
                    Switch(
                      value: c.lowPowerMode,
                      onChanged: c.setLowPowerMode,
                      activeThumbColor: C.lime,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 10),
              const _RfidPanel(),
              if (isAdminOrNull) ...[
                const SizedBox(height: 10),
                _tile(
                  icon: Icons.nfc,
                  title: 'รับค่า RFID',
                  sub: 'อ่านแท็กสด ๆ แบบไม่ผูกกับกล่อง — ดูความเร็วอ่านได้ที่นี่',
                  onTap: () => c.go(Screen.rfidInput),
                ),
              ],
              const SizedBox(height: 16),
              if (c.canConfigureDevice)
                _tile(
                  icon: Icons.router_outlined,
                  title: 'ตั้งค่าเครื่อง',
                  sub: '${c.selWhName} · ประตู ${c.gate} · ที่อยู่เซิร์ฟเวอร์',
                  onTap: c.goDeviceSetup,
                )
              else
                _tile(
                  icon: Icons.lock_outline,
                  title: 'ตั้งค่าเครื่อง',
                  sub: 'เฉพาะหัวหน้างาน — เครื่องนี้ประจำ ${c.selWhName} ประตู ${c.gate}',
                  onTap: null,
                ),
              if (c.emp != null) ...[
                const SizedBox(height: 10),
                _tile(
                  icon: Icons.pin_outlined,
                  title: 'รหัส PIN ส่วนตัว',
                  sub: c.emp!.hasPin
                      ? 'ตั้งไว้แล้ว — แตะเพื่อเปลี่ยนรหัส'
                      : 'ยังไม่ได้ตั้ง — แตะเพื่อตั้งรหัสกันคนอื่นแตะชื่อคุณ',
                  onTap: () => _setupPin(context, c),
                ),
                const SizedBox(height: 10),
                _tile(
                  icon: Icons.swap_horiz,
                  title: 'เปลี่ยนคน / จบงาน',
                  sub: 'กลับไปหน้ายิงบัตร',
                  danger: true,
                  onTap: () => c.lock(),
                ),
              ],
              const SizedBox(height: 18),
              Center(
                child: Text(
                  'BoxTrace PDA · v1.1\nFlutter + Zebra RFIDAPI3 · เชื่อมกับ BoxTrace backend',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.5),
                ),
              ),
            ],
          ),
        ),
      ],
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
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), border: Border.all(color: C.border)),
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
              if (enabled) Icon(Icons.chevron_right, color: C.chevron, size: 20),
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

    if (e.hasPin) {
      String? otpSentTo;
      final verify = await showPinPad(
        context,
        title: 'ใส่รหัส PIN เดิมของ ${e.name}',
        subtitle: 'ยืนยันตัวตนก่อนตั้งรหัสใหม่',
        showForgot: true,
        validate: (entered) async {
          try {
            final ok = await c.api.verifyEmployeePin(e.id, entered);
            if (ok) c.prefs.cachePinHash(e.id, entered);
            return ok ? null : 'รหัสไม่ถูกต้อง ลองใหม่';
          } catch (err) {
            if (c.prefs.verifyPinOffline(e.id, entered)) return null;
            return 'ออฟไลน์ และยังไม่เคยยืนยันรหัสนี้บนเครื่องนี้ตอนออนไลน์มาก่อน';
          }
        },
        onForgot: () async {
          try {
            final req = await c.api.requestPinReset(e.id);
            otpSentTo = req['sentTo']?.toString();
            return null;
          } catch (err) {
            return err is ApiException ? err.message : 'ขอรหัส OTP ไม่สำเร็จ';
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
      title: e.hasPin ? 'ตั้งรหัส PIN ใหม่สำหรับ ${e.name}' : 'ตั้งรหัส PIN สำหรับ ${e.name}',
      subtitle: 'ตั้งรหัส 4 หลักไว้กันคนอื่นแตะชื่อคุณเข้าใช้งาน',
    );
    if (first == null || first.pin == null) return;
    if (!context.mounted) return;
    final confirm = await showPinPad(
      context,
      title: 'ยืนยันรหัส PIN อีกครั้ง',
      subtitle: 'พิมพ์รหัส 4 หลักเดิมอีกครั้งเพื่อยืนยัน',
      validate: (entered) async => entered == first.pin ? null : 'รหัสไม่ตรงกัน ลองใหม่',
    );
    if (confirm == null || confirm.pin == null) return; // cancelled — nothing saved
    if (!context.mounted) return;
    try {
      await c.api.setEmployeePin(e.id, first.pin!);
    } catch (err) {
      if (!context.mounted) return;
      c.toastMsg('ตั้งรหัส PIN ไม่สำเร็จ', '$err', ResultKind.err);
      return;
    }
    c.prefs.clearPinSkip(e.id);
    c.prefs.cachePinHash(e.id, first.pin!);
    c.toastMsg('ตั้งรหัส PIN แล้ว', '', ResultKind.ok);
  }

  /// Same email-OTP reset login_screen.dart's badge flow uses (see its
  /// _forgotPin) — duplicated rather than shared across the two screens'
  /// otherwise-unrelated widget trees, since a fully-independent flow here
  /// keeps this screen's PIN change working even if the badge screen's PIN
  /// pad ever changes shape.
  Future<void> _forgotPinFlow(BuildContext context, AppController c, Employee e, String? sentTo) async {
    c.toastMsg(
      'ส่งรหัส OTP แล้ว',
      sentTo != null ? 'ส่งไปที่อีเมล $sentTo แล้ว — กรอกรหัส 6 หลักด้านล่าง' : 'เช็คอีเมลของคุณแล้วกรอกรหัส 6 หลักด้านล่าง',
      ResultKind.info,
    );
    if (!context.mounted) return;
    final otpResult = await showPinPad(
      context,
      title: 'กรอกรหัส OTP',
      subtitle: sentTo != null ? 'ส่งไปที่ $sentTo (มีอายุ 5 นาที)' : 'รหัส 6 หลักที่ส่งไปทางอีเมล (มีอายุ 5 นาที)',
      length: 6,
    );
    if (otpResult == null || otpResult.pin == null) return;
    final otp = otpResult.pin!;

    if (!context.mounted) return;
    final newPinResult = await showPinPad(context, title: 'ตั้งรหัส PIN ใหม่สำหรับ ${e.name}');
    if (newPinResult == null || newPinResult.pin == null) return;
    final newPin = newPinResult.pin!;

    if (!context.mounted) return;
    final confirm = await showPinPad(
      context,
      title: 'ยืนยันรหัส PIN ใหม่อีกครั้ง',
      validate: (entered) async => entered == newPin ? null : 'รหัสไม่ตรงกัน ลองใหม่',
    );
    if (confirm == null || confirm.pin == null) return;

    if (!context.mounted) return;
    try {
      await c.api.confirmPinReset(e.id, otp: otp, pin: newPin);
    } catch (err) {
      if (!context.mounted) return;
      c.toastMsg('รีเซ็ต PIN ไม่สำเร็จ', err is ApiException ? err.message : '$err', ResultKind.err);
      return;
    }
    c.prefs.clearPinSkip(e.id);
    c.prefs.cachePinHash(e.id, newPin);
    if (!context.mounted) return;
    c.toastMsg('ตั้งรหัส PIN ใหม่แล้ว', '', ResultKind.ok);
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

  /// True while the on-screen "กดค้างเพื่อทดสอบยิง" button is held —
  /// mirrors the physical trigger so a range just set on the slider can be
  /// checked without reaching for the gun.
  bool _testFiring = false;

  @override
  void initState() {
    super.initState();
    _refresh();
    // The tag counter is only useful if it moves while the trigger is held.
    // Low power mode widens this — a diagnostics call every 2s adds up over
    // a shift, and this screen isn't the one place a slow counter matters.
    final lowPower = context.read<AppController>().lowPowerMode;
    _poll = Timer.periodic(Duration(seconds: lowPower ? 5 : 2), (_) => _refresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    // A stray finger-up outside the button (or navigating away mid-press)
    // must not leave the reader sweeping in the background.
    if (_testFiring) context.read<AppController>().rfid.stopInventory();
    super.dispose();
  }

  Future<void> _startTest(AppController c) async {
    if (_testFiring) return;
    setState(() => _testFiring = true);
    await c.rfid.startInventory();
  }

  Future<void> _stopTest(AppController c) async {
    if (!_testFiring) return;
    setState(() => _testFiring = false);
    await c.rfid.stopInventory();
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

  String _label(AppController c) {
    if (!c.rfid.supported) return 'ใช้ได้เฉพาะบนเครื่อง Android ที่มีเครื่องอ่าน Zebra';
    switch (c.rfidStatus.state) {
      case RfidState.connected:
        return 'เชื่อมต่อเครื่องอ่านแล้ว';
      case RfidState.connecting:
        return 'กำลังเชื่อมต่อ…';
      case RfidState.error:
        return 'เชื่อมต่อไม่สำเร็จ';
      case RfidState.disconnected:
        return 'ตัดการเชื่อมต่อ';
      case RfidState.idle:
        return 'ยังไม่ได้เชื่อมต่อ';
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
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
          const Caption('เครื่องอ่าน RFID (Zebra)'),
          const SizedBox(height: 12),
          Row(
            children: [
              Container(
                width: 11,
                height: 11,
                decoration: BoxDecoration(color: _colorFor(c.rfidStatus.state), shape: BoxShape.circle),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Text(_label(c),
                    style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600)),
              ),
              OutlinedButton(
                onPressed: () async {
                  await c.rfid.connect();
                  await _refresh();
                },
                style: OutlinedButton.styleFrom(
                  foregroundColor: C.ink,
                  side: BorderSide(color: C.border2),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
                ),
                child: const Text('เชื่อมต่อใหม่'),
              ),
            ],
          ),
          if (c.rfidStatus.message.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(c.rfidStatus.message, style: TextStyle(fontSize: 12, color: C.muted)),
            ),
          if (c.rfid.supported) ...[
            const SizedBox(height: 14),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            const Text('ระยะยิงแท็ก', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            // The slider needs the reader's own max index to cover every
            // step it actually has (see RfidService.setPowerIndex) — that
            // number only exists once the reader has answered a diagnostics
            // call, so there's honestly nothing precise to show before then.
            if (_d['powerMaxIndex'] is int) ...[
              Builder(builder: (context) {
                final maxIdx = _d['powerMaxIndex'] as int;
                final current = (_rangeIndex ?? (_d['powerIndex'] as int?) ?? maxIdx).clamp(0, maxIdx);
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
                    c.prefs.rfidPowerPercent = maxIdx == 0 ? 100 : ((v / maxIdx) * 100).round();
                    c.rfid.setPowerIndex(v);
                  },
                );
              }),
              const SizedBox(height: 12),
              // Press-and-hold does the same thing the physical trigger
              // does — starts/stops inventory — so a range just dragged on
              // the slider can be checked immediately without setting the
              // handheld down to reach for the gun.
              GestureDetector(
                onTapDown: (_) => _startTest(c),
                onTapUp: (_) => _stopTest(c),
                onTapCancel: () => _stopTest(c),
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 13),
                  decoration: BoxDecoration(
                    color: _testFiring ? C.limeBg : C.neutralBg,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: _testFiring ? C.limeBorder : C.border2),
                  ),
                  alignment: Alignment.center,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.wifi_tethering, size: 17, color: _testFiring ? C.limeDeep : C.ink2),
                      const SizedBox(width: 8),
                      Text(_testFiring ? 'กำลังยิงทดสอบ… ปล่อยนิ้วเพื่อหยุด' : 'กดค้างเพื่อทดสอบยิง',
                          style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                              color: _testFiring ? C.limeDeep : C.ink2)),
                    ],
                  ),
                ),
              ),
            ] else
              Text(
                'เชื่อมต่อเครื่องอ่านก่อน เพื่อปรับระยะยิงแบบละเอียดเต็มสเปกของเครื่องนี้',
                style: TextStyle(fontSize: 12, color: C.faint, height: 1.4),
              ),
            const SizedBox(height: 14),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            Row(
              children: [
                const Expanded(
                  child: Text('กรองสัญญาณอ่อน (RSSI)', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
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
              'ตัดทิ้งแท็กที่อ่านได้อ่อนกว่าค่าที่ตั้ง — กันอ่านทะลุไปโดนพาเลทข้างๆ',
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
            const Text('เสียงบี๊บ', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(
              'แตะเพื่อฟังตัวอย่างแล้วเลือกทันที',
              style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.4),
            ),
            const SizedBox(height: 10),
            _TonePicker(
              value: c.prefs.rfidToneId,
              onChanged: (id) {
                setState(() => c.prefs.rfidToneId = id);
                c.rfid.setBeepStyle(toneId: id, volumePercent: c.prefs.rfidVolumePercent);
                // Selecting a tone plays it immediately — the operator hears
                // what they just picked without a separate "ทดสอบ" tap.
                c.rfid.previewTone(toneId: id, volumePercent: c.prefs.rfidVolumePercent);
              },
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Icon(Icons.volume_down, size: 16, color: C.muted),
                Expanded(
                  child: Slider(
                    value: c.prefs.rfidVolumePercent.toDouble(),
                    min: 1,
                    max: 100,
                    divisions: 99,
                    activeColor: C.lime,
                    label: '${c.prefs.rfidVolumePercent}%',
                    onChanged: (v) => setState(() => c.prefs.rfidVolumePercent = v.round()),
                    onChangeEnd: (v) {
                      final vol = v.round();
                      c.rfid.setBeepStyle(toneId: c.prefs.rfidToneId, volumePercent: vol);
                      c.rfid.previewTone(toneId: c.prefs.rfidToneId, volumePercent: vol);
                    },
                  ),
                ),
                Icon(Icons.volume_up, size: 16, color: C.muted),
                const SizedBox(width: 8),
                SizedBox(
                  width: 36,
                  child: Text('${c.prefs.rfidVolumePercent}%',
                      textAlign: TextAlign.right,
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: C.ink2)),
                ),
              ],
            ),
          ],
          if (!c.rfid.supported)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                'บนเบราว์เซอร์/เดสก์ท็อปจะไม่มีเครื่องอ่าน — ใช้ช่องพิมพ์รหัสแทนได้ '
                'รายละเอียดด้านล่างจะขึ้นเมื่อรันบนเครื่องจริง',
                style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.45),
              ),
            ),
          if (_d.isNotEmpty) ...[
            const SizedBox(height: 14),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            _row('รุ่นเครื่องอ่าน', _d['model']),
            _row('ชื่ออุปกรณ์', _d['host']),
            _row('หมายเลขเครื่อง', _d['serial']),
            _row('เฟิร์มแวร์', _d['firmware']),
            _row('ภูมิภาค (Region)', _d['region']),
            _row('ช่องทางเชื่อมต่อ', _d['transport']),
            _row('กำลังส่ง (index)', power),
            const SizedBox(height: 10),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 12),
            _row('แท็กที่อ่านได้สะสม', '${_d['tagCount'] ?? 0}'),
            _row('EPC ล่าสุด', _d['lastEpc']),
            _row('RSSI ล่าสุด', _d['lastRssi']?.toString()),
            if (_d['lastError'] != null) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: C.redBg,
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Text('ข้อผิดพลาดล่าสุด: ${_d['lastError']}',
                    style: TextStyle(fontSize: 12, color: C.red, height: 1.4)),
              ),
            ],
            const SizedBox(height: 10),
            Text(
              'ทดสอบ: เหนี่ยวไกค้างไว้ 5 วินาทีใกล้กล่องที่ติดแท็ก — ถ้าตัวเลข '
              '"แท็กที่อ่านได้สะสม" เดินขึ้น แปลว่าเครื่องอ่านทำงานครบวงจรแล้ว',
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

/// Beep sound picker (see rfid_service.dart's kRfidTones) — a row of chips
/// rather than a dropdown since the whole catalog is short enough to lay
/// out flat, and a chip tap doubles as the "listen to it" gesture (the
/// caller plays a live preview onChanged, per the "เมื่อเลือกให้เล่นเสียงเลย" ask).
class _TonePicker extends StatelessWidget {
  final String value;
  final ValueChanged<String> onChanged;
  const _TonePicker({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: kRfidTones.map((t) {
        final selected = t.id == value;
        return GestureDetector(
          onTap: () => onChanged(t.id),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
            decoration: BoxDecoration(
              color: selected ? C.ink : C.neutralBg,
              borderRadius: BorderRadius.circular(11),
              border: Border.all(color: selected ? C.ink : C.border2),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(selected ? Icons.volume_up : Icons.play_arrow,
                    size: 14, color: selected ? C.surface : C.ink2),
                const SizedBox(width: 6),
                Text(t.label,
                    style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: selected ? C.surface : C.ink2)),
              ],
            ),
          ),
        );
      }).toList(),
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(value <= -80 ? 'หลวม · รับเกือบทุกแท็ก' : value <= -55 ? 'ปานกลาง' : 'เข้ม · เฉพาะแท็กใกล้มาก',
                style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w600)),
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
            overlayColor: C.ink.withOpacity(0.12),
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
  const _RangePicker({required this.value, required this.max, required this.onChanged});

  /// The index range varies by reader model, so classification has to be
  /// relative to [max] — this is the same ใกล้/ปานกลาง/ไกล vocabulary the
  /// original preset picker used, now derived from position instead of
  /// snapped to it.
  String _label(int v) {
    if (max <= 0) return '';
    final pct = v / max * 100;
    if (pct <= 40) return 'ใกล้ · ~30 ซม.';
    if (pct <= 75) return 'ปานกลาง · ~1-2 ม.';
    return 'ไกล · สุดกำลังเครื่อง';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(_label(value), style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w600)),
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
            overlayColor: C.ink.withOpacity(0.12),
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
            _stepButton(Icons.remove, value > 0 ? () => onChanged(value - 1) : null),
            const SizedBox(width: 14),
            _stepButton(Icons.add, value < max ? () => onChanged(value + 1) : null),
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
