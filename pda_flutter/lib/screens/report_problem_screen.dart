import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_capture.dart';

enum _Kind { missing, unreadableTag, damaged }

enum _Mode { report, resolve }

/// "แจ้งปัญหาหน้างาน" — the PDA's floor-exception buttons: "ของหาย" (a
/// system-directed pick/putaway landed here and the box wasn't), "อ่านแท็กไม่
/// ติด / ป้ายหาย" (the box is right there but its RFID/barcode won't read),
/// and "กล่องชำรุด" (found damaged). Backed by POST /api/reports.
///
/// All three kinds are box-scoped and all three flip real box state (see the
/// backend route's own doc comment) — which means every one of them needs a
/// way back, not just a way in. [_Mode.resolve] is the same screen with the
/// same three kinds, just pointed at boxes that currently have that kind's
/// report open and calling POST /api/reports/resolve instead: "เจอของแล้ว" /
/// "อ่านแท็กติดแล้ว / ป้ายไม่หายแล้ว" / "ซ่อมแล้ว". A report an operator can
/// only ever file and never close trains them to stop trusting the button.
///
/// "ช่องเก็บเต็ม" (a suggested shelf already full in person) used to be a
/// fourth, location-scoped kind here. It was dropped entirely rather than
/// given a resolve step — nothing box-shaped to scan back "not full" against
/// keeps the same shape as the other three, and Location Master already
/// covers clearing that flag from the dashboard.
class ReportProblemScreen extends StatefulWidget {
  const ReportProblemScreen({super.key});
  @override
  State<ReportProblemScreen> createState() => _ReportProblemScreenState();
}

class _ReportProblemScreenState extends State<ReportProblemScreen> {
  _Mode _mode = _Mode.report;
  _Kind? _kind;
  Box? _box;
  String? _scanError;
  bool _busy = false;
  bool _sent = false;

  /// Narrows the box pick-list to one product type at a time — null means
  /// "all types". Same affordance RfidLocateScreen's own pick step uses: the
  /// box an operator is reporting is exactly the one they *can't* scan (it's
  /// missing, or its tag won't read), so a browsable list is the only way in,
  /// and a warehouse-wide alphabetical list needs a type filter to be usable.
  String? _typeFilter;

  static String _apiKind(_Kind k) => switch (k) {
        _Kind.missing => 'missing',
        _Kind.unreadableTag => 'unreadable_tag',
        _Kind.damaged => 'damaged',
      };

  /// Whether [b] currently has an open report of kind [k] — the boundary
  /// between "offer to file" (report mode) and "offer to close" (resolve
  /// mode) for that box.
  static bool _isOpen(_Kind k, Box b) => switch (k) {
        _Kind.missing => b.status == 'lost',
        _Kind.damaged => b.status == 'damage',
        _Kind.unreadableTag => b.tagIssueOpen,
      };

  void _setMode(_Mode m) {
    if (m == _mode) return;
    setState(() {
      _mode = m;
      _kind = null;
      _box = null;
      _scanError = null;
      _typeFilter = null;
    });
  }

  void _pickKind(_Kind k) {
    setState(() {
      _kind = k;
      _box = null;
      _scanError = null;
      _typeFilter = null;
    });
  }

  void _onScan(AppController c, String raw) {
    final s = c.S;
    final kind = _kind;
    if (s == null || kind == null) return;
    final b = s.box(c.resolveTag(raw));
    if (b == null) {
      setState(() => _scanError = 'ไม่พบกล่องรหัส "$raw"');
      return;
    }
    if (_mode == _Mode.report && _isOpen(kind, b)) {
      setState(() => _scanError = '${b.tag} แจ้งปัญหานี้ไว้อยู่แล้ว');
      return;
    }
    if (_mode == _Mode.resolve && !_isOpen(kind, b)) {
      setState(() => _scanError = '${b.tag} ไม่ได้เปิดปัญหานี้ไว้');
      return;
    }
    setState(() {
      _scanError = null;
      _box = b;
    });
  }

  Future<void> _submit(AppController c) async {
    final kind = _kind;
    final box = _box;
    if (_busy || kind == null || box == null) return;
    final loc = context.read<LocaleController>();
    setState(() {
      _busy = true;
      _scanError = null;
    });
    try {
      if (_mode == _Mode.report) {
        await c.api.report(kind: _apiKind(kind), tag: box.tag);
      } else {
        await c.api.resolveReport(kind: _apiKind(kind), tag: box.tag);
      }
      if (!mounted) return;
      c.rfid.playSound('putaway_ok');
      await c.refresh();
      if (!mounted) return;
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
      _scanError = null;
      _sent = false;
      _typeFilter = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final kind = _kind;
    final target = _box != null;

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
              ? [_modeToggle(loc), const SizedBox(height: 14), ..._kindPicker(c, loc)]
              : target
                  ? _confirmBody(c, loc)
                  : _scanBody(c, loc, kind),
        ),
      ),
    );
  }

  Widget _modeToggle(LocaleController loc) => Row(
        children: [
          Expanded(
            child: _modeTab(loc.t('แจ้งปัญหา'), _Mode.report),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: _modeTab(loc.t('ปิดปัญหา'), _Mode.resolve),
          ),
        ],
      );

  Widget _modeTab(String label, _Mode m) {
    final selected = _mode == m;
    return Material(
      color: selected ? C.ink : C.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _setMode(m),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: selected ? C.ink : C.border),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: selected ? C.onHero : C.ink2,
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _kindPicker(AppController c, LocaleController loc) {
    final resolve = _mode == _Mode.resolve;
    return [
      _kindTile(
        icon: resolve ? Icons.check_circle_outline : Icons.search_off,
        color: C.red,
        bg: C.redBg,
        title: loc.t(resolve ? 'เจอของแล้ว' : 'ของหาย'),
        sub: loc.t(resolve
            ? 'ยิงบาร์โค้ดกล่องที่เคยแจ้งของหาย'
            : 'ยิงบาร์โค้ดกล่อง — ระบบสั่งมาที่นี่แต่ไม่พบของ'),
        onTap: () => _pickKind(_Kind.missing),
      ),
      const SizedBox(height: 10),
      _kindTile(
        icon: resolve ? Icons.nfc : Icons.sensors_off,
        color: C.red,
        bg: C.redBg,
        title: loc.t(resolve ? 'อ่านแท็กติดแล้ว / ป้ายไม่หายแล้ว' : 'อ่านแท็กไม่ติด / ป้ายหาย'),
        sub: loc.t(resolve
            ? 'ยิงบาร์โค้ดกล่องที่เคยแจ้งอ่านแท็กไม่ติด'
            : 'หากล่องเจอ แต่ RFID/บาร์โค้ดอ่านไม่ได้'),
        onTap: () => _pickKind(_Kind.unreadableTag),
      ),
      const SizedBox(height: 10),
      _kindTile(
        icon: resolve ? Icons.build_circle_outlined : Icons.broken_image_outlined,
        color: C.orange,
        bg: C.orangeBg,
        title: loc.t(resolve ? 'ซ่อมแล้ว' : 'กล่องชำรุด'),
        sub: loc.t(resolve
            ? 'ยิงบาร์โค้ดกล่องที่เคยแจ้งชำรุด'
            : 'เจอกล่องที่สั่งมาหยิบ แต่ชำรุด/เสียหาย ใช้งานไม่ได้'),
        onTap: () => _pickKind(_Kind.damaged),
      ),
    ];
  }

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

  List<Widget> _scanBody(AppController c, LocaleController loc, _Kind kind) {
    final resolve = _mode == _Mode.resolve;
    return [
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
                loc.t(resolve
                    ? 'ยิงบาร์โค้ดกล่องที่จะปิดปัญหา'
                    : switch (kind) {
                        _Kind.unreadableTag => 'ยิงบาร์โค้ดกล่องที่อ่านแท็กไม่ติด',
                        _Kind.damaged => 'ยิงบาร์โค้ดกล่องที่ชำรุด',
                        _Kind.missing => 'ยิงบาร์โค้ดกล่องที่หา',
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
      ..._boxPickList(c, loc, kind),
    ];
  }

  /// Browsable box list, grouped behind a product-type filter exactly like
  /// RfidLocateScreen's own pick step. In report mode this matters more than
  /// there: the box being reported is by definition one the operator
  /// *cannot* scan (it's missing, or its tag won't read), so without this the
  /// only way to file the report is to already know the tag by heart and have
  /// something else to scan it off. In resolve mode it's the list of boxes
  /// that currently have this kind's report open, which is at least as
  /// important — that's the only way to find *which* boxes still need
  /// closing without already knowing the tag.
  List<Widget> _boxPickList(
      AppController c, LocaleController loc, _Kind kind) {
    final s = c.S;
    if (s == null) return const [];
    final resolve = _mode == _Mode.resolve;

    // Report mode: only boxes physically on hand and without this issue
    // already open. Resolve mode: only boxes that currently have this
    // issue open (which for "missing"/"damaged" means status 'lost'/'damage'
    // — deliberately outside the on-hand set, since that's exactly what
    // opening the report moved them out of).
    final candidates = resolve
        ? s.boxes.where((b) => _isOpen(kind, b))
        : s.boxes
            .where((b) => const {'warehouse', 'hold', 'damage'}.contains(b.status))
            .where((b) => !_isOpen(kind, b));
    final onHand = candidates.toList()..sort((a, b) => a.tag.compareTo(b.tag));

    // Distinct types actually present — a type with no candidate box would
    // just be a dead-end chip. '' stands in for "no type set" so it stays a
    // normal map key.
    final typeNames = <String, String>{};
    for (final b in onHand) {
      typeNames[b.type ?? ''] = s.typeName(b.type);
    }
    final typeIds = typeNames.keys.toList()
      ..sort((a, b) => typeNames[a]!.compareTo(typeNames[b]!));
    if (_typeFilter != null && !typeIds.contains(_typeFilter)) {
      _typeFilter = null; // the selected type's last candidate box went away
    }
    final shown = _typeFilter == null
        ? onHand
        : onHand.where((b) => (b.type ?? '') == _typeFilter).toList();

    if (onHand.isEmpty) return const [];

    return [
      const SizedBox(height: 14),
      Text(loc.t('หรือเลือกจากรายการ'),
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
      if (shown.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 4),
          child: Text(loc.t('ไม่มีกล่องประเภทนี้ในคลัง'),
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
            children: List.generate(shown.length, (i) {
              final b = shown[i];
              final sm = StatusMeta.of(b.status);
              return InkWell(
                // Same landing point a successful scan reaches — straight to
                // the confirm step for this box, no separate flow.
                onTap: () => setState(() {
                  _scanError = null;
                  _box = b;
                }),
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    border: i == shown.length - 1
                        ? null
                        : Border(bottom: BorderSide(color: C.border)),
                  ),
                  child: Row(
                    children: [
                      Icon(
                          kind == _Kind.missing
                              ? Icons.inventory_2_outlined
                              : kind == _Kind.damaged
                                  ? Icons.broken_image_outlined
                                  : Icons.nfc,
                          size: 18,
                          color: C.muted),
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
                            // Type stays on every row even with a type chip
                            // active — with "ทั้งหมด" selected it's the only
                            // thing telling one box apart from the next — and
                            // the shelf it should be on is exactly what an
                            // operator checks before calling it missing. A box
                            // still waiting on putaway has no shelf at all,
                            // hence the join rather than a fixed separator.
                            Text(
                                [
                                  s.typeName(b.type),
                                  locationText(b.location
                                      .map((k, v) => MapEntry(k, '$v'))),
                                ].where((v) => v.isNotEmpty).join(' · '),
                                style:
                                    TextStyle(fontSize: 12, color: C.muted)),
                          ],
                        ),
                      ),
                      Pill(sm.label, color: sm.color, bg: sm.bg, fontSize: 11),
                    ],
                  ),
                ),
              );
            }),
          ),
        ),
    ];
  }

  List<Widget> _confirmBody(AppController c, LocaleController loc) {
    final b = _box!;
    final resolve = _mode == _Mode.resolve;
    final kind = _kind!;
    final actionLabel = resolve
        ? switch (kind) {
            _Kind.missing => 'เจอของแล้ว',
            _Kind.unreadableTag => 'อ่านแท็กติดแล้ว / ป้ายไม่หายแล้ว',
            _Kind.damaged => 'ซ่อมแล้ว',
          }
        : 'ส่งรายงาน';
    return [
      Panel(
        radius: 18,
        padding: const EdgeInsets.all(18),
        child: Column(
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
          child: Text(_busy ? loc.t('กำลังบันทึก…') : loc.t(actionLabel)),
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
    final resolve = _mode == _Mode.resolve;
    return Container(
      color: C.limeBg,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.check_circle, size: 84, color: C.limeText),
            const SizedBox(height: 14),
            Text(loc.t(resolve ? 'ปิดปัญหาแล้ว' : 'บันทึกรายงานแล้ว'),
                style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                    color: C.limeText)),
            const SizedBox(height: 18),
            TextButton(
              onPressed: _reset,
              child: Text(loc.t(resolve ? 'ปิดอีกรายการ' : 'แจ้งอีกรายการ')),
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
