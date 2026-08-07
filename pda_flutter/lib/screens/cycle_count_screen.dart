import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../models/location.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Cycle count (ตรวจนับสต็อก) — sweep a zone/rack and compare what the
/// antenna actually finds against what the WMS believes is stored there.
///
/// Deliberately **read-only**. It files nothing: there is no count-session
/// endpoint on the backend, and inventing one client-side would mean this
/// screen silently rewriting stock records from a single operator's sweep,
/// which is exactly the kind of unreviewed adjustment a cycle count exists to
/// prevent. What it produces is the variance list — ครบ / ขาด / เกิน — which
/// is the thing a supervisor acts on. Boxes found in the wrong place can be
/// corrected on the spot through ย้ายตำแหน่ง, and missing ones reported
/// through แจ้งกล่องเสียหาย/สูญหาย; both already write through proper,
/// audited endpoints.
///
/// The scope is a location, not a box list, because that is how a count is
/// actually walked: stand in an aisle, hold the trigger, sweep the rack.
class CycleCountScreen extends StatefulWidget {
  const CycleCountScreen({super.key});
  @override
  State<CycleCountScreen> createState() => _CycleCountScreenState();
}

/// Where a box ended up relative to what the WMS expected in this scope.
enum _Verdict {
  /// Expected here, and the sweep found it.
  matched,

  /// Expected here, nothing answered. Either genuinely gone, or simply out of
  /// antenna range — which is why this is a list to re-sweep, not a writeback.
  missing,

  /// Answered here but the WMS has it somewhere else (or nowhere).
  unexpected,
}

class _CycleCountScreenState extends State<CycleCountScreen> {
  String? _zone;
  String? _rack;

  bool _counting = false;
  bool _started = false;

  /// EPC/TID reads collapsed to box tags. A set because a rack sweep reads the
  /// same tag hundreds of times and only "did it answer at all" matters here.
  final Set<String> _seen = {};

  /// Reads that resolved to no box in this WMS at all — worth surfacing
  /// separately from "a box that belongs elsewhere", because an unknown tag is
  /// usually an uncommissioned box rather than a misplaced one.
  final Set<String> _unknownEpcs = {};

  StreamSubscription<List<RfidTagRead>>? _tagSub;
  StreamSubscription<bool>? _triggerSub;

  AppController get _c => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    final rfid = _c.rfid;
    _tagSub = rfid.tagBatches.listen(_onBatch);
    _triggerSub = rfid.triggers.listen((p) {
      if (mounted) setState(() => _counting = p);
      if (p) setState(() => _started = true);
    });
  }

  @override
  void dispose() {
    _c.rfid.stopInventory();
    _tagSub?.cancel();
    _triggerSub?.cancel();
    super.dispose();
  }

  void _onBatch(List<RfidTagRead> batch) {
    final s = _c.S;
    if (s == null) return;
    var changed = false;
    for (final r in batch) {
      if (r.epc.isEmpty) continue;
      final tag = s.tagForCode(r.epc);
      if (tag == null) {
        if (_unknownEpcs.add(r.epc)) changed = true;
      } else if (_seen.add(tag)) {
        changed = true;
      }
    }
    if (changed && mounted) setState(() {});
  }

  Future<void> _toggleCount() async {
    final c = _c;
    if (!c.rfid.supported) return;
    if (_counting) {
      setState(() => _counting = false);
      await c.rfid.stopInventory();
      return;
    }
    if (c.rfidCharging) {
      c.toastMsg('ตรวจนับไม่ได้ขณะชาร์จ', 'ยกเครื่องออกจากแท่นชาร์จก่อน', ResultKind.warn);
      return;
    }
    setState(() {
      _counting = true;
      _started = true;
    });
    await c.rfid.startInventory();
  }

  void _reset() {
    _c.rfid.stopInventory();
    setState(() {
      _seen.clear();
      _unknownEpcs.clear();
      _counting = false;
      _started = false;
    });
  }

  /// Boxes the WMS believes are in the selected scope right now.
  List<Box> _expected(AppController c) {
    final all = c.S?.boxes ?? const <Box>[];
    return all.where((b) {
      if (b.status != 'warehouse' && b.status != 'hold') return false;
      final l = b.location;
      if ((l['wh'] ?? '').toString() != c.wh) return false;
      if (_zone != null && (l['zone'] ?? '').toString() != _zone) return false;
      if (_rack != null && (l['rack'] ?? '').toString() != _rack) return false;
      return true;
    }).toList()
      ..sort((a, b) => a.tag.compareTo(b.tag));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final cascade = LocationCascade(c.S?.locations ?? const {});
    final expected = _expected(c);
    final expectedTags = expected.map((b) => b.tag).toSet();

    final matched = expected.where((b) => _seen.contains(b.tag)).toList();
    final missing = expected.where((b) => !_seen.contains(b.tag)).toList();
    // Read here but booked somewhere else — the other half of a variance, and
    // the half a location-scoped count would otherwise miss entirely.
    final unexpected = _seen
        .where((t) => !expectedTags.contains(t))
        .map((t) => c.S?.box(t))
        .whereType<Box>()
        .toList()
      ..sort((a, b) => a.tag.compareTo(b.tag));

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: const Text('ตรวจนับสต็อก'),
          subtitle: Text('${c.selWhName}${_zone == null ? '' : ' · โซน $_zone'}${_rack == null ? '' : ' · $_rack'}'),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
            children: [
              _scopeCard(c, cascade),
              const SizedBox(height: 13),
              _sweepCard(c, expected.length),
              const SizedBox(height: 13),
              if (_started) ...[
                _scoreboard(matched.length, missing.length, unexpected.length),
                const SizedBox(height: 13),
                if (missing.isNotEmpty)
                  _resultGroup(c, 'ขาด — ไม่พบในการกวาด', missing, _Verdict.missing),
                if (unexpected.isNotEmpty)
                  _resultGroup(c, 'เกิน — เจอแต่ระบบว่าอยู่ที่อื่น', unexpected, _Verdict.unexpected),
                if (matched.isNotEmpty)
                  _resultGroup(c, 'ครบ — ตรงกับระบบ', matched, _Verdict.matched),
                if (_unknownEpcs.isNotEmpty) _unknownCard(),
              ] else
                _Note('เลือกขอบเขตที่จะนับ แล้วเหนี่ยวไกกวาดไปตามแร็ค '
                    'ระบบจะเทียบสิ่งที่อ่านได้กับสิ่งที่ระบบบันทึกไว้ให้อัตโนมัติ'),
            ],
          ),
        ),
      ],
    );
  }

  Widget _scopeCard(AppController c, LocationCascade cascade) {
    final zones = cascade.zones(c.wh);
    final racks = cascade.racks(c.wh, _zone);
    return Panel(
      padding: const EdgeInsets.all(16),
      radius: 18,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const FieldLabel('ขอบเขตการนับ'),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const FieldLabel('โซน'),
                    _scopeDropdown(_zone, zones, 'ทั้งคลัง', (v) {
                      setState(() {
                        _zone = v;
                        _rack = null;
                      });
                      _reset();
                    }),
                  ],
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const FieldLabel('แร็ค'),
                    _scopeDropdown(_rack, racks, 'ทั้งโซน', (v) {
                      setState(() => _rack = v);
                      _reset();
                    }),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// Plain dropdown, not AddableDropdown: counting is an audit of what already
  /// exists, so inventing a new location from this screen would be nonsense.
  Widget _scopeDropdown(String? value, List<String> options, String allLabel, ValueChanged<String?> onChanged) {
    return DropdownButtonFormField<String>(
      initialValue: options.contains(value) ? value : null,
      isExpanded: true,
      decoration: pdaInput(allLabel, radius: 12),
      hint: Text(allLabel, style: TextStyle(color: C.faint)),
      items: [
        DropdownMenuItem<String>(value: null, child: Text(allLabel, style: TextStyle(color: C.muted))),
        ...options.map((o) => DropdownMenuItem(value: o, child: Text(o))),
      ],
      onChanged: onChanged,
    );
  }

  Widget _sweepCard(AppController c, int expectedCount) {
    return Panel(
      padding: const EdgeInsets.all(16),
      radius: 18,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('ระบบคาดว่ามี $expectedCount กล่องในขอบเขตนี้',
                    style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
              ),
              if (_started)
                GestureDetector(
                  onTap: _reset,
                  child: Text('เริ่มนับใหม่',
                      style: TextStyle(fontSize: 12.5, color: C.orange, fontWeight: FontWeight.w700)),
                ),
            ],
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: c.rfid.supported ? _toggleCount : null,
              icon: Icon(_counting ? Icons.stop : Icons.wifi_tethering, size: 18),
              label: Text(_counting ? 'กำลังกวาดนับ… แตะเพื่อหยุด' : 'เริ่มกวาดนับ (หรือเหนี่ยวไก)',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
              style: FilledButton.styleFrom(
                backgroundColor: _counting ? C.red : C.ink,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _scoreboard(int matched, int missing, int unexpected) {
    Widget cell(String label, int n, Color color, Color bg) => Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 13),
            decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(13)),
            child: Column(
              children: [
                Text('$n',
                    style: TextStyle(
                        fontSize: 22, fontWeight: FontWeight.w800, color: color, height: 1.1)),
                const SizedBox(height: 2),
                Text(label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: color)),
              ],
            ),
          ),
        );
    return Row(
      children: [
        cell('ครบ', matched, C.limeText, C.limeBg),
        const SizedBox(width: 9),
        cell('ขาด', missing, C.red, C.redBg),
        const SizedBox(width: 9),
        cell('เกิน', unexpected, C.orange, C.orangeBg),
      ],
    );
  }

  Widget _resultGroup(AppController c, String title, List<Box> boxes, _Verdict verdict) {
    late Color accent;
    switch (verdict) {
      case _Verdict.matched:
        accent = C.limeText;
        break;
      case _Verdict.missing:
        accent = C.red;
        break;
      case _Verdict.unexpected:
        accent = C.orange;
        break;
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 13),
      child: Panel(
        padding: const EdgeInsets.all(14),
        radius: 16,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('$title · ${boxes.length}',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: accent)),
            const SizedBox(height: 8),
            ...boxes.take(40).map((b) {
              final l = b.location;
              final where = [l['zone'], l['rack'], l['shelf'], l['slot']]
                  .map((e) => (e ?? '').toString())
                  .where((e) => e.isNotEmpty)
                  .join(' · ');
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(b.tag,
                              style: const TextStyle(
                                  fontSize: 14, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                          Text(
                            verdict == _Verdict.unexpected
                                ? '${c.S!.typeName(b.type)} · ระบบว่าอยู่ ${where.isEmpty ? "ไม่ระบุตำแหน่ง" : where}'
                                : '${c.S!.typeName(b.type)}${where.isEmpty ? '' : ' · $where'}',
                            style: TextStyle(fontSize: 11.5, color: C.muted),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              );
            }),
            if (boxes.length > 40)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('…และอีก ${boxes.length - 40} กล่อง',
                    style: TextStyle(fontSize: 11.5, color: C.faint)),
              ),
          ],
        ),
      ),
    );
  }

  Widget _unknownCard() {
    return Panel(
      padding: const EdgeInsets.all(14),
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('แท็กที่ไม่รู้จัก · ${_unknownEpcs.length}',
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: C.muted)),
          const SizedBox(height: 4),
          Text('อ่านเจอแต่ยังไม่ได้ผูกกับกล่องใดในระบบ — ใช้เมนู "ลงทะเบียนแท็ก RFID" เพื่อผูก',
              style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.4)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: _unknownEpcs
                .take(12)
                .map((e) => Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(color: C.neutralBg, borderRadius: BorderRadius.circular(8)),
                      child: Text(e, style: TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: C.ink2)),
                    ))
                .toList(),
          ),
        ],
      ),
    );
  }
}

/// Local copy of the home screen's hint block — same visual weight, without
/// making that private widget public just for this one use.
class _Note extends StatelessWidget {
  final String text;
  const _Note(this.text);
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: C.neutralBg,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: C.border),
      ),
      child: Text(text, style: TextStyle(fontSize: 12.5, color: C.ink3, height: 1.5)),
    );
  }
}
