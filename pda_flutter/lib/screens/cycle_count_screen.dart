import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// "ตรวจนับ" — a plain reconciliation sweep over one warehouse/zone: pick
/// the location, see every box the system expects there, then scan and
/// watch them tick off. No backend endpoint exists for cycle counts (or
/// audits/stocktakes) at all, so this works entirely off the already-cached
/// box list ([AppController.S]) — nothing here is written back to the
/// server; it's a read-only reconciliation aid an operator uses to see
/// what's missing or unexpectedly present before chasing it down by hand.
class CycleCountScreen extends StatefulWidget {
  const CycleCountScreen({super.key});
  @override
  State<CycleCountScreen> createState() => _CycleCountScreenState();
}

class _CycleCountScreenState extends State<CycleCountScreen> {
  final _scanCtrl = TextEditingController();
  final _scanFocus = FocusNode();
  Timer? _autoSubmitTimer;
  static const _autoSubmitDelay = Duration(milliseconds: 180);
  static const _autoSubmitMinLen = 2;
  int _prevLen = 0;

  String? _zone; // null = whole warehouse
  final Set<String> _scanned = {};
  final List<String> _unexpected = []; // scanned but not expected in this zone

  AppController get _c => context.read<AppController>();

  @override
  void dispose() {
    _autoSubmitTimer?.cancel();
    _scanCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  List<Box> _expected(AppController c) {
    final all = c.S?.boxes.where((b) => b.status == 'warehouse' && b.location['wh'] == c.wh).toList() ?? const <Box>[];
    if (_zone == null || _zone!.isEmpty) return all;
    return all.where((b) => (b.location['zone'] ?? '').toString() == _zone).toList();
  }

  List<String> _zonesInWh(AppController c) {
    final all = c.S?.boxes.where((b) => b.status == 'warehouse' && b.location['wh'] == c.wh) ?? const <Box>[];
    final zones = all.map((b) => (b.location['zone'] ?? '').toString()).where((z) => z.isNotEmpty).toSet().toList()
      ..sort();
    return zones;
  }

  void _onScanChanged() {
    _autoSubmitTimer?.cancel();
    final text = _scanCtrl.text.trim();
    final addedChars = _scanCtrl.text.length - _prevLen;
    _prevLen = _scanCtrl.text.length;
    if (text.isEmpty || text.length < _autoSubmitMinLen) return;
    if (addedChars > 1) {
      _submitScan(text);
      return;
    }
    _autoSubmitTimer = Timer(_autoSubmitDelay, () {
      if (!mounted || _scanCtrl.text.trim() != text) return;
      _submitScan(text);
    });
  }

  void _submitScan(String raw) {
    final c = _c;
    final tag = c.resolveTag(raw);
    _scanCtrl.clear();
    _prevLen = 0;
    final expectedTags = _expected(c).map((b) => b.tag).toSet();
    setState(() {
      if (expectedTags.contains(tag)) {
        _scanned.add(tag);
      } else if (!_scanned.contains(tag) && !_unexpected.contains(tag)) {
        // Not expected in this zone/warehouse at all — either it belongs
        // somewhere else, or it isn't 'warehouse' status right now. Flagged
        // rather than silently dropped, since "a box that shouldn't be here
        // is here" is exactly the kind of thing a cycle count exists to
        // catch.
        _unexpected.insert(0, tag);
      }
    });
  }

  void _reset() {
    setState(() {
      _scanned.clear();
      _unexpected.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final expected = _expected(c);
    final missing = expected.where((b) => !_scanned.contains(b.tag)).toList();
    final zones = _zonesInWh(c);

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: Text(loc.t('ตรวจนับ')),
          subtitle: Text('${c.selWhName}${_zone != null && _zone!.isNotEmpty ? ' · ${loc.t('โซน')} $_zone' : ''}'),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
            children: [
              if (zones.isNotEmpty) ...[
                Text(loc.t('เลือกโซนที่จะตรวจนับ'),
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _zoneChip(loc.t('ทั้งคลัง'), _zone == null, () => setState(() { _zone = null; _reset(); })),
                    ...zones.map((z) => _zoneChip(z, _zone == z, () => setState(() { _zone = z; _reset(); }))),
                  ],
                ),
                const SizedBox(height: 14),
              ],
              TextField(
                controller: _scanCtrl,
                focusNode: _scanFocus,
                autofocus: true,
                textCapitalization: TextCapitalization.characters,
                autocorrect: false,
                enableSuggestions: false,
                onChanged: (_) => _onScanChanged(),
                onSubmitted: (_) => _submitScan(_scanCtrl.text.trim()),
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
                decoration: InputDecoration(
                  hintText: loc.t('ยิงบาร์โค้ด หรือพิมพ์รหัส'),
                  hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 15),
                  prefixIcon: Icon(Icons.checklist, color: C.muted),
                  isDense: true,
                  filled: true,
                  fillColor: C.surface,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: C.fieldBorder, width: 1.5)),
                  enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: C.fieldBorder, width: 1.5)),
                  focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: C.ink, width: 1.5)),
                ),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(child: _CountStat(value: '${expected.length}', label: loc.t('คาดว่ามี'), color: C.ink)),
                  const SizedBox(width: 9),
                  Expanded(child: _CountStat(value: '${_scanned.length}', label: loc.t('พบแล้ว'), color: C.limeText)),
                  const SizedBox(width: 9),
                  Expanded(child: _CountStat(value: '${missing.length}', label: loc.t('ยังไม่พบ'), color: C.orange)),
                ],
              ),
              if (_unexpected.isNotEmpty) ...[
                const SizedBox(height: 14),
                Caption(loc.t('ไม่ควรอยู่ที่นี่')),
                const SizedBox(height: 8),
                ..._unexpected.map((tag) {
                  final b = c.S?.box(tag);
                  return _rowTile(
                    tag: tag,
                    sub: b == null
                        ? loc.t('ไม่พบกล่องนี้ในระบบ')
                        : '${c.S?.typeName(b.type) ?? ''} · ${StatusMeta.of(b.status).label}',
                    color: C.red,
                    icon: Icons.error_outline,
                  );
                }),
              ],
              if (missing.isNotEmpty) ...[
                const SizedBox(height: 14),
                Caption(loc.t('ยังไม่พบ')),
                const SizedBox(height: 8),
                ...missing.map((b) => _rowTile(
                      tag: b.tag,
                      sub: c.S?.typeName(b.type) ?? '',
                      color: C.faint,
                      icon: Icons.radio_button_unchecked,
                    )),
              ],
              if (_scanned.isNotEmpty) ...[
                const SizedBox(height: 14),
                Caption(loc.t('พบแล้ว')),
                const SizedBox(height: 8),
                ..._scanned.map((tag) {
                  final b = c.S?.box(tag);
                  return _rowTile(
                    tag: tag,
                    sub: b != null ? (c.S?.typeName(b.type) ?? '') : '',
                    color: C.limeText,
                    icon: Icons.check_circle,
                  );
                }),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _zoneChip(String label, bool selected, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
        decoration: BoxDecoration(
          color: selected ? C.ink : C.neutralBg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: selected ? C.ink : C.border2),
        ),
        child: Text(label,
            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: selected ? C.surface : C.ink2)),
      ),
    );
  }

  Widget _rowTile({required String tag, required String sub, required Color color, required IconData icon}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
        decoration: BoxDecoration(color: C.surface, borderRadius: BorderRadius.circular(13), border: Border.all(color: C.border)),
        child: Row(
          children: [
            Icon(icon, size: 18, color: color),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(tag, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                  if (sub.isNotEmpty) Text(sub, style: TextStyle(fontSize: 11.5, color: C.muted)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CountStat extends StatelessWidget {
  final String value, label;
  final Color color;
  const _CountStat({required this.value, required this.label, required this.color});
  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(value, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: color)),
          Text(label, style: TextStyle(fontSize: 11, color: C.muted, fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }
}
