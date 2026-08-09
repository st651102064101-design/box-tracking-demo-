import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_capture.dart';

enum _Kind { missing, binFull, unreadableTag }

/// "แจ้งปัญหาหน้างาน" — the PDA's floor-exception buttons: "ของหาย" (a
/// system-directed pick/putaway landed here and the box wasn't), "ช่องเก็บเต็ม"
/// (a suggested shelf is already full in person), and "อ่านแท็กไม่ติด" (the
/// box is right there but its RFID/barcode won't read). Backed by
/// POST /api/reports. "กล่องชำรุด" (damaged) is also picked from this
/// screen's kind tiles, but isn't one of this screen's own report kinds —
/// it forwards straight into HoldReleaseScreen (see _kindPicker), since
/// hold/damage is a full status change with its own release path that this
/// screen's scan-then-confirm shape doesn't fit, not a report to log.
class ReportProblemScreen extends StatefulWidget {
  const ReportProblemScreen({super.key});
  @override
  State<ReportProblemScreen> createState() => _ReportProblemScreenState();
}

class _ReportProblemScreenState extends State<ReportProblemScreen> {
  _Kind? _kind;
  Box? _box;
  Map<String, String>? _location;
  String? _scanError;
  bool _busy = false;
  bool _sent = false;

  /// "ของหาย" browse-by-type filter — same idea as RfidLocateScreen's pick
  /// step: null means "all types". Exists because a box the system directed
  /// you to but couldn't be found is, by definition, not there to scan — the
  /// only way to name it is to pick it off a list, and a warehouse-wide
  /// alphabetical list is unusable without narrowing by type first.
  String? _typeFilter;

  void _pickKind(_Kind k) {
    setState(() {
      _kind = k;
      _box = null;
      _location = null;
      _scanError = null;
      _typeFilter = null;
    });
  }

  void _pickFromList(Box b) {
    setState(() {
      _scanError = null;
      _box = b;
    });
  }

  void _onScan(AppController c, String raw) {
    final s = c.S;
    if (s == null) return;
    if (_kind == _Kind.missing || _kind == _Kind.unreadableTag) {
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
    // bin_full — a shelf/rack barcode, not a box.
    final found = s.locationByCode(c.wh, raw);
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
    final loc = context.read<LocaleController>();
    setState(() {
      _busy = true;
      _scanError = null;
    });
    try {
      await c.api.report(
        kind: switch (_kind) {
          _Kind.missing => 'missing',
          _Kind.unreadableTag => 'unreadable_tag',
          _ => 'bin_full',
        },
        tag: _box?.tag,
        location: _location,
      );
      if (!mounted) return;
      c.rfid.playSound('putaway_ok');
      setState(() => _sent = true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _scanError =
          e is ApiException ? e.message : loc.t('บันทึกไม่สำเร็จ'));
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
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final kind = _kind;
    final target = _box != null || _location != null;

    if (_sent) return _successStep(loc);

    return ScanCapture(
      enabled: kind != null && !target && !_busy,
      onScan: (raw) => _onScan(c, raw),
      child: AutoHideHeader(
        header: StickyHeader(
          onBack: kind == null ? c.backToHome : _reset,
          title: Text(loc.t('แจ้งปัญหาหน้างาน')),
        ),
        body: ListView(
          padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
          children: kind == null
              ? _kindPicker(c, loc)
              : target
                  ? _confirmBody(c, loc)
                  : _scanBody(c, loc, kind),
        ),
      ),
    );
  }

  List<Widget> _kindPicker(AppController c, LocaleController loc) => [
        _kindTile(
          icon: Icons.search_off,
          color: C.red,
          bg: C.redBg,
          title: loc.t('ของหาย'),
          sub: loc.t('ยิงบาร์โค้ดกล่อง — ระบบสั่งมาที่นี่แต่ไม่พบของ'),
          onTap: () => _pickKind(_Kind.missing),
        ),
        const SizedBox(height: 10),
        _kindTile(
          icon: Icons.inbox,
          color: C.orange,
          bg: C.orangeBg,
          title: loc.t('ช่องเก็บเต็ม'),
          sub: loc.t('ยิงบาร์โค้ดชั้นวาง — ช่องที่ระบบแนะนำเต็มแล้วจริง'),
          onTap: () => _pickKind(_Kind.binFull),
        ),
        const SizedBox(height: 10),
        // Forwards straight into HoldReleaseScreen — see the class doc
        // comment for why this isn't one of this screen's own report kinds.
        _kindTile(
          icon: Icons.broken_image_outlined,
          color: C.orange,
          bg: C.orangeBg,
          title: loc.t('กล่องชำรุด'),
          sub: loc.t('เจอกล่องที่สั่งมาหยิบ แต่ชำรุด/เสียหาย ใช้งานไม่ได้'),
          onTap: c.goHoldRelease,
        ),
        const SizedBox(height: 10),
        _kindTile(
          icon: Icons.sensors_off,
          color: C.red,
          bg: C.redBg,
          title: loc.t('อ่านแท็กไม่ติด / ป้ายหาย'),
          sub: loc.t('หากล่องเจอ แต่ RFID/บาร์โค้ดอ่านไม่ได้'),
          onTap: () => _pickKind(_Kind.unreadableTag),
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
                    Text(sub, style: TextStyle(fontSize: 12.5, color: C.muted)),
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

  List<Widget> _scanBody(AppController c, LocaleController loc, _Kind kind) => [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 22),
          decoration: BoxDecoration(
            color: C.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: C.fieldBorder, width: 1.5),
          ),
          child: Column(
            children: [
              Icon(Icons.qr_code_scanner, size: 26, color: C.muted),
              const SizedBox(height: 8),
              Text(
                  loc.t(switch (kind) {
                    _Kind.missing => 'ยิงบาร์โค้ดกล่องที่หา',
                    _Kind.unreadableTag => 'ยิงบาร์โค้ดกล่องที่อ่านแท็กไม่ติด',
                    _ => 'ยิงบาร์โค้ดชั้นวางที่เต็ม',
                  }),
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
        // ของหาย only: nothing to scan for a box that, by definition, isn't
        // where it should be — browse by type instead, same shape as
        // RfidLocateScreen's pick-from-list step.
        if (kind == _Kind.missing) ..._typePickList(c, loc),
      ];

  /// Every box this device's warehouse currently expects on a shelf, filtable
  /// by type first (a flat alphabetical list of a whole warehouse isn't
  /// scannable by eye) — see [_typeFilter]. Tapping one reports it missing
  /// directly, the same as scanning it would if it were actually there.
  List<Widget> _typePickList(AppController c, LocaleController loc) {
    final all = (c.S?.boxes.toList() ?? const <Box>[])
        .where((b) => b.status == 'warehouse' && b.location['wh'] == c.wh)
        .toList()
      ..sort((a, b) => a.tag.compareTo(b.tag));

    final typeNames = <String, String>{}; // type id -> display name
    for (final b in all) {
      final id = b.type ?? '';
      typeNames[id] = c.S!.typeName(b.type);
    }
    final typeIds = typeNames.keys.toList()
      ..sort((a, b) => typeNames[a]!.compareTo(typeNames[b]!));
    if (_typeFilter != null && !typeIds.contains(_typeFilter)) {
      _typeFilter = null; // the selected type's last box moved out/shipped
    }
    final boxes = _typeFilter == null
        ? all
        : all.where((b) => (b.type ?? '') == _typeFilter).toList();

    return [
      const SizedBox(height: 16),
      if (all.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 4),
          child: Text(loc.t('ไม่มีกล่องที่คลังนี้'),
              style: TextStyle(fontSize: 13, color: C.faint, height: 1.4)),
        )
      else ...[
        Text(loc.t('หรือเลือกกล่องตามประเภท'),
            style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w700, color: C.muted)),
        const SizedBox(height: 8),
        if (typeIds.length > 1) ...[
          SizedBox(
            height: 34,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    label: Text(loc.t('ทั้งหมด')),
                    selected: _typeFilter == null,
                    onSelected: (_) => setState(() => _typeFilter = null),
                  ),
                ),
                for (final id in typeIds)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: ChoiceChip(
                      label: Text(typeNames[id]!),
                      selected: _typeFilter == id,
                      onSelected: (_) => setState(() => _typeFilter = id),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],
        if (boxes.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 4),
            child: Text(loc.t('ไม่มีกล่องประเภทนี้ที่คลังนี้'),
                style: TextStyle(fontSize: 13, color: C.faint, height: 1.4)),
          )
        else
          Container(
            decoration: BoxDecoration(
              color: C.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: C.border),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: List.generate(boxes.length, (i) {
                final b = boxes[i];
                return InkWell(
                  onTap: () => _pickFromList(b),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      border: i == boxes.length - 1
                          ? null
                          : Border(bottom: BorderSide(color: C.border)),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.inventory_2_outlined,
                            size: 18, color: C.muted),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(b.tag,
                                  style: const TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w700,
                                      fontFamily: 'monospace')),
                              Text(c.S!.typeName(b.type),
                                  style:
                                      TextStyle(fontSize: 12, color: C.muted)),
                            ],
                          ),
                        ),
                        Icon(Icons.chevron_right, size: 18, color: C.faint),
                      ],
                    ),
                  ),
                );
              }),
            ),
          ),
      ],
    ];
  }

  List<Widget> _confirmBody(AppController c, LocaleController loc) {
    final b = _box;
    final l = _location;
    return [
      Panel(
        radius: 18,
        padding: const EdgeInsets.all(18),
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
                  Text(locationText(l!),
                      style: const TextStyle(
                          fontSize: 22, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text(c.selWhName,
                      style: TextStyle(fontSize: 13, color: C.muted)),
                ],
              ),
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
          child: Text(_busy ? loc.t('กำลังบันทึก…') : loc.t('ส่งรายงาน')),
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

  Widget _successStep(LocaleController loc) {
    final c = context.read<AppController>();
    return Container(
      color: C.limeBg,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.check_circle, size: 84, color: C.limeText),
            const SizedBox(height: 14),
            Text(loc.t('บันทึกรายงานแล้ว'),
                style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                    color: C.limeText)),
            const SizedBox(height: 18),
            // อ่านแท็กไม่ติด is only half done once logged — the box still
            // needs a working tag, so the fastest next step is straight
            // into the screen that actually fixes that, not back to a menu.
            if (_kind == _Kind.unreadableTag)
              FilledButton(
                onPressed: c.goRfidRegister,
                style: FilledButton.styleFrom(
                  backgroundColor: C.ink,
                  padding: const EdgeInsets.symmetric(
                      horizontal: 22, vertical: 12),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
                child: Text(loc.t('ไปผูกแท็กใหม่')),
              ),
            const SizedBox(height: 10),
            TextButton(
              onPressed: _reset,
              child: Text(loc.t('แจ้งอีกรายการ')),
            ),
            TextButton(
              onPressed: c.backToHome,
              child: Text(loc.t('กลับหน้าหลัก')),
            ),
          ],
        ),
      ),
    );
  }
}
