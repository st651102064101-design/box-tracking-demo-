import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
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
                  sub: '${c.selWhName} · ประตู ${c.gate} · เซิร์ฟเวอร์ + บัญชีเครื่อง',
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

  /// Lets an already-signed-in operator set (or replace) their own PIN —
  /// the way in for whoever tapped "ข้าม / ไม่ตั้ง PIN" the first time and
  /// changed their mind, or wants a new one. No old-PIN check: they're
  /// already authenticated for this session, that's the whole point of
  /// putting this here instead of only on the badge screen.
  Future<void> _setupPin(BuildContext context, AppController c) async {
    final e = c.emp;
    if (e == null) return;
    final first = await showPinPad(
      context,
      title: e.hasPin ? 'ตั้งรหัส PIN ใหม่สำหรับ ${e.name}' : 'ตั้งรหัส PIN สำหรับ ${e.name}',
      subtitle: 'ตั้งรหัส 4 หลักไว้กันคนอื่นแตะชื่อคุณเข้าใช้งาน',
    );
    if (first == null || first.pin == null) return;
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
    c.toastMsg('ตั้งรหัส PIN แล้ว', '', ResultKind.ok);
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

  @override
  void initState() {
    super.initState();
    _refresh();
    // The tag counter is only useful if it moves while the trigger is held.
    _poll = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
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
            if (_d['powerMaxIndex'] is int)
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
              })
            else
              Text(
                'เชื่อมต่อเครื่องอ่านก่อน เพื่อปรับระยะยิงแบบละเอียดเต็มสเปกของเครื่องนี้',
                style: TextStyle(fontSize: 12, color: C.faint, height: 1.4),
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
      ],
    );
  }
}
