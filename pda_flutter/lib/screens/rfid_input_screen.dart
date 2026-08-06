import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// One *tag*, not one read — every field the SDK reported for it, plus how
/// many times it has come back and when it was last seen.
///
/// A held trigger re-reads the same tag many times a second; listing each of
/// those separately buried the handful of distinct tags actually in front of
/// the antenna under thousands of duplicate rows. Counting repeats instead
/// keeps one row per physical tag and turns the repeats into the useful part:
/// how strongly and how often each tag is answering.
class _Tag {
  final String epc;
  final DateTime firstAt;
  DateTime lastAt;
  int count = 1;
  String? tid;
  int? rssi;
  int? bestRssi;
  int? pc;
  String? crc;
  int? antenna;
  String? channel;
  int? phase;
  int? seenCount;

  _Tag({
    required this.epc,
    required this.firstAt,
    required this.lastAt,
    this.tid,
    this.rssi,
    this.bestRssi,
    this.pc,
    this.crc,
    this.antenna,
    this.channel,
    this.phase,
    this.seenCount,
  });

  factory _Tag.fromRead(RfidTagRead r, DateTime at) => _Tag(
        epc: r.epc,
        firstAt: at,
        lastAt: at,
        tid: r.tid,
        rssi: r.rssi,
        bestRssi: r.rssi,
        pc: r.pc,
        crc: r.crc,
        antenna: r.antenna,
        channel: r.channel,
        phase: r.phase,
        seenCount: r.seenCount,
      );

  /// Folds a fresh read of this same tag in. Fields only ever move from
  /// unknown to known — a later read that happens to omit the TID (a lean
  /// inventory round) must not wipe one an earlier read established.
  void merge(RfidTagRead r, DateTime at) {
    lastAt = at;
    count++;
    if (r.rssi != null) {
      rssi = r.rssi;
      if (bestRssi == null || r.rssi! > bestRssi!) bestRssi = r.rssi;
    }
    tid ??= r.tid;
    pc ??= r.pc;
    crc ??= r.crc;
    antenna ??= r.antenna;
    channel ??= r.channel;
    phase ??= r.phase;
    if (r.seenCount != null) seenCount = r.seenCount;
  }

  /// The EPC as the reader gives it (hex) converted to base-10 — a 24-hex-digit
  /// EPC like `000000000000000000000005` reads a lot more like "a tag" and a
  /// lot less like a wall of hex once it's just `5`. BigInt because a full
  /// 96-bit EPC overflows a 64-bit int. Null for anything that isn't valid
  /// hex (e.g. a manually-typed code).
  String? get decimal {
    final hex = epc.replaceAll(RegExp(r'\s'), '');
    if (hex.isEmpty || !RegExp(r'^[0-9A-Fa-f]+$').hasMatch(hex)) return null;
    return BigInt.parse(hex, radix: 16).toString();
  }
}

/// The one RFID bench screen: connect to the reader, hold the trigger (or tap
/// "เริ่มอ่าน"), and see exactly what comes back — EPC, TID, RSSI and the rest
/// of the raw SDK fields, one row per distinct tag with a repeat count, plus a
/// live read rate and a range control.
///
/// Reading raw tags and testing the reader used to be two separate places that
/// did nearly the same thing; they are one screen because in practice they are
/// one activity.
class RfidInputScreen extends StatefulWidget {
  const RfidInputScreen({super.key});

  @override
  State<RfidInputScreen> createState() => _RfidInputScreenState();
}

class _RfidInputScreenState extends State<RfidInputScreen> {
  final _manualCtrl = TextEditingController();

  /// Distinct tags, most recently *discovered* first. Repeats update a row in
  /// place rather than reordering: rows that jump around while the trigger is
  /// held are unreadable.
  final List<_Tag> _tags = [];
  final Map<String, _Tag> _byEpc = {};

  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<RfidStatus>? _statusSub;
  StreamSubscription<bool>? _triggerSub;
  late RfidStatus _status;
  bool _reading = false;
  late int _powerPercent;

  /// Held for [dispose], which can't reach the provider through `context`.
  late final RfidService _rfid;
  late final AppController _app;

  /// Read-rate accounting. The screen repaints on a timer rather than on every
  /// read: at the rates this reader can hit, calling setState per tag would
  /// spend the whole frame budget rebuilding the list.
  int _totalReads = 0;
  int _windowReads = 0;
  int _ratePerSec = 0;
  int _peakRatePerSec = 0;
  Timer? _ticker;
  bool _dirty = false;

  @override
  void initState() {
    super.initState();
    final c = context.read<AppController>();
    _app = c;
    _rfid = c.rfid;
    _powerPercent = c.prefs.rfidPowerPercent;
    _status = RfidStatus(_rfid.state, '');
    // This is the screen that exists to show what the SDK returns, so it opts
    // into the full field set and the explicit TID read. Both cost read rate,
    // which is why every other screen leaves them off.
    _rfid.setDetailed(true);
    _tagSub = _rfid.tagReads.listen(_onRead);
    _statusSub = _rfid.status.listen((s) {
      if (mounted) setState(() => _status = s);
      // The reader resets to full power on every connect.
      if (s.state == RfidState.connected) _rfid.setPowerPercent(_powerPercent);
    });
    // The physical gun trigger drives start/stopInventory from AppController
    // (see _onReaderTrigger) — mirror that here so the on-screen button stays
    // in sync whether the read was started by a tap or a trigger pull.
    _triggerSub = _rfid.triggers.listen((pressed) {
      if (mounted) setState(() => _reading = pressed);
    });
    if (_rfid.supported && _rfid.state != RfidState.connected) _rfid.connect();
    _ticker = Timer.periodic(const Duration(seconds: 1), _tick);
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _statusSub?.cancel();
    _triggerSub?.cancel();
    _ticker?.cancel();
    _rfid.setDetailed(false);
    _rfid.setPowerPercent(_app.prefs.rfidPowerPercent);
    unawaited(_rfid.stopInventory());
    _manualCtrl.dispose();
    super.dispose();
  }

  /// Folds one read into the tag list. Deliberately does no setState — see
  /// [_tick] for why the repaint is on a timer.
  void _onRead(RfidTagRead r) {
    if (r.epc.isEmpty) return;
    final now = DateTime.now();
    _totalReads++;
    _windowReads++;
    final existing = _byEpc[r.epc];
    if (existing != null) {
      existing.merge(r, now);
    } else {
      final t = _Tag.fromRead(r, now);
      _byEpc[r.epc] = t;
      _tags.insert(0, t);
    }
    _dirty = true;
  }

  void _tick(Timer _) {
    if (!mounted) return;
    final rate = _windowReads;
    _windowReads = 0;
    if (rate > _peakRatePerSec) _peakRatePerSec = rate;
    if (!_dirty && rate == _ratePerSec) return;
    setState(() {
      _ratePerSec = rate;
      _dirty = false;
    });
  }

  Future<void> _toggleRead() async {
    if (!_rfid.supported) return;
    if (_reading) {
      await _rfid.stopInventory();
      if (mounted) setState(() => _reading = false);
    } else {
      setState(() => _reading = true);
      await _rfid.startInventory();
    }
  }

  void _addManual() {
    final v = _manualCtrl.text.trim();
    if (v.isEmpty) return;
    final now = DateTime.now();
    setState(() {
      final existing = _byEpc[v];
      if (existing != null) {
        existing.lastAt = now;
        existing.count++;
      } else {
        final t = _Tag(epc: v, firstAt: now, lastAt: now);
        _byEpc[v] = t;
        _tags.insert(0, t);
      }
    });
    _manualCtrl.clear();
  }

  void _clear() {
    setState(() {
      _tags.clear();
      _byEpc.clear();
      _totalReads = 0;
      _windowReads = 0;
      _ratePerSec = 0;
      _peakRatePerSec = 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final connected = _status.state == RfidState.connected;

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: const Text('อ่าน / ทดสอบแท็ก RFID'),
          subtitle: const Text('ค่าดิบจากเครื่องอ่าน — EPC, TID, RSSI'),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 16),
            children: [
              Panel(
                padding: const EdgeInsets.all(16),
                radius: 18,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 11,
                          height: 11,
                          decoration: BoxDecoration(
                            color: connected ? C.lime : (_status.state == RfidState.connecting ? C.orange : C.red),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 11),
                        Expanded(
                          child: Text(
                            !c.rfid.supported
                                ? 'ใช้ได้เฉพาะบนเครื่องอ่าน Zebra'
                                : connected
                                    ? 'เชื่อมต่อเครื่องอ่านแล้ว'
                                    : _status.state == RfidState.connecting
                                        ? 'กำลังเชื่อมต่อ…'
                                        : (_status.message.isEmpty ? 'ยังไม่ได้เชื่อมต่อ' : _status.message),
                            style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: c.rfid.supported ? _toggleRead : null,
                        icon: Icon(_reading ? Icons.stop : Icons.wifi_tethering),
                        label: Text(_reading ? 'หยุดอ่าน' : 'เริ่มอ่าน RFID'),
                        style: FilledButton.styleFrom(
                          backgroundColor: _reading ? C.red : C.ink,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                      ),
                    ),
                    if (c.rfid.supported) ...[
                      const SizedBox(height: 14),
                      Divider(height: 1, color: C.border),
                      const SizedBox(height: 12),
                      // Range lives here as well as in settings: near-vs-far
                      // behaviour is exactly what this screen is for, and
                      // proving it needs the power changed and re-tested on
                      // the spot rather than two screens away.
                      const Text('ระยะยิงแท็ก (ทดสอบ)',
                          style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
                      const SizedBox(height: 8),
                      _PowerPicker(
                        value: _powerPercent,
                        onChanged: (v) {
                          setState(() => _powerPercent = v);
                          _rfid.setPowerPercent(v);
                        },
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 12),
              _statsRow(),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _manualCtrl,
                      autocorrect: false,
                      enableSuggestions: false,
                      onSubmitted: (_) => _addManual(),
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 15),
                      decoration: InputDecoration(
                        hintText: 'หรือพิมพ์รหัสเอง',
                        hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 14),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
                        filled: true,
                        fillColor: C.surface,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 44,
                    height: 46,
                    child: FilledButton(
                      onPressed: _addManual,
                      style: FilledButton.styleFrom(
                        backgroundColor: C.ink,
                        padding: EdgeInsets.zero,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                      ),
                      child: const Icon(Icons.add, size: 20),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('พบ ${_tags.length} แท็ก · อ่านรวม $_totalReads ครั้ง',
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: C.ink)),
                  if (_tags.isNotEmpty)
                    GestureDetector(
                      onTap: _clear,
                      child: Text('ล้างรายการ', style: TextStyle(fontSize: 12.5, color: C.muted)),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              if (_tags.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 26),
                  child: Center(
                    child: Text('ยังไม่มีข้อมูล — กด "เริ่มอ่าน RFID" แล้วยิงแท็ก',
                        style: TextStyle(fontSize: 13, color: C.faint)),
                  ),
                )
              else
                ..._tags.map(_tagCard),
            ],
          ),
        ),
      ],
    );
  }

  /// Rate and peak rate, so "is it reading rapidly?" is a number on screen
  /// rather than an impression.
  Widget _statsRow() {
    return Row(
      children: [
        Expanded(child: _stat('อ่าน/วินาที', '$_ratePerSec')),
        const SizedBox(width: 8),
        Expanded(child: _stat('สูงสุด/วินาที', '$_peakRatePerSec')),
        const SizedBox(width: 8),
        Expanded(child: _stat('แท็กที่พบ', '${_tags.length}')),
      ],
    );
  }

  Widget _stat(String label, String value) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: C.border),
      ),
      child: Column(
        children: [
          Text(value,
              style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800, fontFamily: 'monospace')),
          const SizedBox(height: 2),
          Text(label, style: TextStyle(fontSize: 10.5, color: C.muted), textAlign: TextAlign.center),
        ],
      ),
    );
  }

  Widget _tagCard(_Tag t) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
        decoration: BoxDecoration(
          color: C.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: C.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.nfc, size: 18, color: C.muted),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(t.epc,
                          style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w700,
                              fontFamily: 'monospace',
                              letterSpacing: 0.4)),
                      if (t.decimal != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text('เลขฐาน 10: ${t.decimal}',
                              style: TextStyle(fontSize: 12, fontFamily: 'monospace', color: C.muted)),
                        ),
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: C.limeBg,
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(color: C.limeBorder),
                      ),
                      child: Text('×${t.count}',
                          style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w800,
                              color: C.limeDeep,
                              fontFamily: 'monospace')),
                    ),
                    const SizedBox(height: 3),
                    Text(_fmtTime(t.lastAt), style: TextStyle(fontSize: 11, color: C.faint)),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 9),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 9),
            Wrap(
              spacing: 16,
              runSpacing: 6,
              children: [
                // RSSI first, and with the strongest reading kept alongside
                // the latest: how close a tag is is the field this screen gets
                // opened to answer.
                _field('RSSI', t.rssi == null ? null : '${t.rssi} dBm'),
                _field('RSSI สูงสุด', t.bestRssi == null ? null : '${t.bestRssi} dBm'),
                _field('TID', t.tid),
                _field('PC', t.pc?.toRadixString(16).toUpperCase()),
                _field('CRC', t.crc),
                _field('Antenna', t.antenna?.toString()),
                _field('Channel', t.channel),
                _field('Phase', t.phase?.toString()),
                _field('Seen', t.seenCount?.toString()),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(String label, String? value) {
    return SizedBox(
      width: 140,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('$label ', style: TextStyle(fontSize: 11.5, color: C.muted)),
          Expanded(
            child: Text(
              value == null || value.isEmpty ? '—' : value,
              style: TextStyle(
                fontSize: 11.5,
                fontFamily: 'monospace',
                color: value == null || value.isEmpty ? C.faint : C.ink,
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _fmtTime(DateTime t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')}';
}

/// ใกล้ / ปานกลาง / ไกล, the same three steps the settings picker offers —
/// duplicated here rather than shared because this one is a scratch control
/// that reverts when the screen closes, not the saved operator preference.
class _PowerPicker extends StatelessWidget {
  static const _steps = [
    (label: 'ใกล้', percent: 30),
    (label: 'ปานกลาง', percent: 65),
    (label: 'ไกล', percent: 100),
  ];

  final int value;
  final ValueChanged<int> onChanged;
  const _PowerPicker({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final nearest = _steps.reduce(
      (a, b) => (value - a.percent).abs() <= (value - b.percent).abs() ? a : b,
    );
    return Row(
      children: _steps.map((s) {
        final selected = s == nearest;
        return Expanded(
          child: Padding(
            padding: const EdgeInsets.only(right: 6),
            child: GestureDetector(
              onTap: () => onChanged(s.percent),
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 9),
                decoration: BoxDecoration(
                  color: selected ? C.ink : C.neutralBg,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: selected ? C.ink : C.border2),
                ),
                child: Text(
                  s.label,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: selected ? C.onInk : C.ink,
                  ),
                ),
              ),
            ),
          ),
        );
      }).toList(),
    );
  }
}
