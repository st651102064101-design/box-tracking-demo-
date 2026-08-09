import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../models/location.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_capture.dart';

enum _Kind { missing, binFull }

/// "แจ้งปัญหาหน้างาน" — the PDA's floor-exception buttons: "ของหาย" (a
/// system-directed pick/putaway landed here and the box wasn't) and
/// "ช่องเก็บเต็ม" (a suggested shelf is already full in person). Backed by
/// POST /api/reports, which — deliberately — only ever records the report:
/// no status change, no location change. Only a person standing in the
/// aisle can tell "genuinely missing" apart from "mis-shelved", or "full"
/// apart from "I miscounted"; this button is that person raising a hand,
/// not a correction.
class ReportProblemScreen extends StatefulWidget {
  const ReportProblemScreen({super.key});
  @override
  State<ReportProblemScreen> createState() => _ReportProblemScreenState();
}

class _ReportProblemScreenState extends State<ReportProblemScreen> {
  _Kind? _kind;
  Box? _box;
  Location? _location;
  String? _scanError;
  bool _busy = false;
  bool _sent = false;
  final _noteCtrl = TextEditingController();

  @override
  void dispose() {
    _noteCtrl.dispose();
    super.dispose();
  }

  void _pickKind(_Kind k) {
    setState(() {
      _kind = k;
      _box = null;
      _location = null;
      _scanError = null;
      _noteCtrl.clear();
    });
  }

  void _onScan(AppController c, String raw) {
    final s = c.S;
    if (s == null) return;
    if (_kind == _Kind.missing) {
      final b = s.box(c.resolveTag(raw));
      if (b == null) {
        setState(() => _scanError = 'ไม่พบกล่องรหัส "$raw"');
        return;
      }
      setState(() {
        _scanError = null;
        _box = b;
      });
      return;
    }
    // bin_full — a shelf/rack barcode, not a box. Locations are keyed by
    // their own scannable code (see StateSnapshot.locations).
    final needle = raw.trim().toLowerCase();
    Location? found;
    for (final entry in s.locations.entries) {
      if (entry.key.toLowerCase() != needle) continue;
      if (entry.value.wh != c.wh) continue;
      found = entry.value;
      break;
    }
    if (found == null) {
      setState(() => _scanError = 'ไม่พบตำแหน่งรหัส "$raw"');
      return;
    }
    setState(() {
      _scanError = null;
      _location = found;
    });
  }

  Future<void> _submit(AppController c) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _scanError = null;
    });
    try {
      await c.api.report(
        kind: _kind == _Kind.missing ? 'missing' : 'bin_full',
        tag: _box?.tag,
        location: _location == null
            ? null
            : {
                'wh': _location!.wh,
                'zone': _location!.zone,
                'rack': _location!.rack,
                'shelf': _location!.shelf,
                'slot': _location!.slot,
              },
        note: _noteCtrl.text.trim(),
      );
      if (!mounted) return;
      c.rfid.playSound('putaway_ok');
      setState(() => _sent = true);
    } catch (e) {
      if (!mounted) return;
      setState(() =>
          _scanError = e is ApiException ? e.message : 'บันทึกไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _reset() {
    setState(() {
      _kind = null;
      _box = null;
      _location = null;
      _scanError = null;
      _sent = false;
      _noteCtrl.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final kind = _kind;
    final target = _box != null || _location != null;

    if (_sent) return _successStep();

    return ScanCapture(
      enabled: kind != null && !target && !_busy,
      onScan: (raw) => _onScan(c, raw),
      child: Column(
        children: [
          StickyHeader(
            onBack: kind == null ? c.backToHome : _reset,
            title: const Text('แจ้งปัญหาหน้างาน'),
          ),
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
              children: kind == null
                  ? _kindPicker()
                  : target
                      ? _confirmBody(c, kind)
                      : _scanBody(kind),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _kindPicker() => [
        _kindTile(
          icon: Icons.search_off,
          color: C.red,
          bg: C.redBg,
          title: 'ของหาย',
          sub: 'ยิงบาร์โค้ดกล่อง — ระบบสั่งมาที่นี่แต่ไม่พบของ',
          onTap: () => _pickKind(_Kind.missing),
        ),
        const SizedBox(height: 10),
        _kindTile(
          icon: Icons.inbox,
          color: C.orange,
          bg: C.orangeBg,
          title: 'ช่องเก็บเต็ม',
          sub: 'ยิงบาร์โค้ดชั้นวาง — ช่องที่ระบบแนะนำเต็มแล้วจริง',
          onTap: () => _pickKind(_Kind.binFull),
        ),
      ];

  Widget _kindTile({
    required IconData icon,
    required Color color,
    required Color bg,
    required String title,
    required String sub,
    required VoidCallback onTap,
  }) {
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: C.border)),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                    color: bg, borderRadius: BorderRadius.circular(13)),
                child: Icon(icon, color: color, size: 25),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w700)),
                    Text(sub,
                        style: TextStyle(fontSize: 12.5, color: C.muted)),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, color: C.chevron, size: 22),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _scanBody(_Kind kind) => [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 22),
          decoration: BoxDecoration(
            color: C.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: C.border, width: 1.5),
          ),
          child: Column(
            children: [
              Icon(Icons.qr_code_scanner, size: 26, color: C.muted),
              const SizedBox(height: 8),
              Text(
                  kind == _Kind.missing
                      ? 'ยิงบาร์โค้ดกล่องที่หา'
                      : 'ยิงบาร์โค้ดชั้นวางที่เต็ม',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontSize: 14,
                      color: C.muted,
                      fontWeight: FontWeight.w600)),
            ],
          ),
        ),
        if (_scanError != null) ...[
          const SizedBox(height: 10),
          Text(_scanError!,
              style: TextStyle(
                  fontSize: 13, color: C.red, fontWeight: FontWeight.w600)),
        ],
      ];

  String _locText(Location l) => [l.zone, l.rack, l.shelf, l.slot]
      .where((v) => v.isNotEmpty)
      .join(' / ');

  List<Widget> _confirmBody(AppController c, _Kind kind) {
    final b = _box;
    final l = _location;
    return [
      Panel(
        child: b != null
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(b.tag,
                      style: const TextStyle(
                          fontSize: 22,
                          fontWeight: FontWeight.w800,
                          fontFamily: 'monospace')),
                  const SizedBox(height: 4),
                  Text(c.S?.typeName(b.type) ?? '-',
                      style: TextStyle(fontSize: 13, color: C.muted)),
                ],
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_locText(l!),
                      style: const TextStyle(
                          fontSize: 22, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text(c.selWhName,
                      style: TextStyle(fontSize: 13, color: C.muted)),
                ],
              ),
      ),
      const SizedBox(height: 16),
      FieldLabel('รายละเอียดเพิ่มเติม (ถ้ามี)'),
      const SizedBox(height: 6),
      TextField(
        controller: _noteCtrl,
        maxLines: 2,
        decoration: pdaInput(
            kind == _Kind.missing
                ? 'เช่น หาในโซนใกล้เคียงแล้วไม่พบ'
                : 'เช่น มีของวางเกินที่ระบบบันทึกไว้',
            radius: 12),
      ),
      const SizedBox(height: 16),
      SizedBox(
        width: double.infinity,
        child: FilledButton(
          onPressed: _busy ? null : () => _submit(c),
          style: FilledButton.styleFrom(
            backgroundColor: C.ink,
            padding: const EdgeInsets.symmetric(vertical: 15),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
          child: Text(_busy ? 'กำลังบันทึก…' : 'ส่งรายงาน'),
        ),
      ),
      if (_scanError != null) ...[
        const SizedBox(height: 12),
        Text(_scanError!,
            style: TextStyle(
                fontSize: 13, color: C.red, fontWeight: FontWeight.w600)),
      ],
    ];
  }

  Widget _successStep() {
    return Container(
      color: C.limeBg,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.check_circle, size: 84, color: C.limeDeep),
            const SizedBox(height: 14),
            Text('บันทึกรายงานแล้ว',
                style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                    color: C.limeText)),
            const SizedBox(height: 18),
            TextButton(onPressed: _reset, child: const Text('แจ้งอีกรายการ')),
            TextButton(
              onPressed: () => context.read<AppController>().backToHome(),
              child: const Text('กลับหน้าหลัก'),
            ),
          ],
        ),
      ),
    );
  }
}
