import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// "ตรวจนับ" — a stock take over one warehouse, optionally narrowed to a
/// single zone.
///
/// Backed by the server's cycle-count session API (`POST /api/cycle-counts`,
/// `/scan`, `/close`): the count is a real record with an id, an actor and an
/// audit entry, not something that evaporates when this screen closes. Scans
/// are posted to the session as they're found rather than held until the end,
/// so a handheld that dies mid-aisle doesn't take the whole count with it —
/// reopening the same zone resumes the session that's already running.
///
/// `expected` comes from the server and is frozen at open time; this screen
/// never recomputes it locally, because the whole point of a count is
/// comparing what was *believed* to be on the shelf against what was found.
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
  bool _busy = false;
  String? _error;

  /// The open session, straight from the server. Null until one is started.
  Map<String, dynamic>? _session;

  /// Tags queued locally because a scan landed while offline or while another
  /// post was still in flight — flushed on the next successful post so a dead
  /// zone doesn't silently drop reads.
  final List<String> _pending = [];

  AppController get _c => context.read<AppController>();

  @override
  void dispose() {
    _autoSubmitTimer?.cancel();
    _scanCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  List<String> _zonesInWh(AppController c) {
    final all = c.S?.boxes.where(
            (b) => b.status == 'warehouse' && b.location['wh'] == c.wh) ??
        const <Box>[];
    final zones = all
        .map((b) => (b.location['zone'] ?? '').toString())
        .where((z) => z.isNotEmpty)
        .toSet()
        .toList()
      ..sort();
    return zones;
  }

  List<String> _list(String key) {
    final v = _session?[key];
    return v is List ? v.map((e) => e.toString()).toList() : const [];
  }

  int _summary(String key) {
    final s = _session?['summary'];
    if (s is Map && s[key] is num) return (s[key] as num).toInt();
    return 0;
  }

  Future<void> _start() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final s = await _c.api.openCycleCount(wh: _c.wh, zone: _zone ?? '');
      if (!mounted) return;
      setState(() => _session = s);
      if (s['resumed'] == true) {
        _c.toastMsg('ทำต่อรอบเดิม', '${s['id']}', ResultKind.info);
      }
      _scanFocus.requestFocus();
    } catch (e) {
      if (!mounted) return;
      setState(
          () => _error = e is ApiException ? e.message : _c.errorMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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

  Future<void> _submitScan(String raw) async {
    final session = _session;
    if (session == null || raw.isEmpty) return;
    _scanCtrl.clear();
    _prevLen = 0;
    // Codes go up as typed — the server resolves barcode/EPC/TID itself, so
    // resolving locally first would only narrow what it can match.
    _pending.add(raw);
    if (_busy) return; // a post is already in flight; it'll pick these up
    await _flush();
  }

  Future<void> _flush() async {
    final session = _session;
    if (session == null || _pending.isEmpty) return;
    final batch = List<String>.from(_pending);
    _pending.clear();
    setState(() => _busy = true);
    try {
      final s = await _c.api.cycleCountScan(session['id'].toString(), batch);
      if (!mounted) return;
      setState(() {
        _session = s;
        _error = null;
      });
      final unknown =
          (s['unknown'] is List) ? (s['unknown'] as List) : const [];
      if (unknown.isNotEmpty) {
        _c.toastMsg('ไม่พบรหัสนี้ในระบบ', unknown.join(', '), ResultKind.warn);
      }
    } catch (e) {
      if (!mounted) return;
      // Put them back so nothing is lost — the next scan retries the lot.
      _pending.insertAll(0, batch);
      setState(
          () => _error = e is ApiException ? e.message : _c.errorMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
      if (_pending.isNotEmpty && mounted && _error == null) await _flush();
    }
  }

  Future<void> _close() async {
    final session = _session;
    if (session == null || _busy) return;
    final loc = context.read<LocaleController>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(loc.t('ปิดรอบตรวจนับ')),
        content: Text(
          '${loc.t('พบแล้ว')} ${_summary('counted')}/${_summary('expected')}'
          ' · ${loc.t('ยังไม่พบ')} ${_summary('missing')}'
          ' · ${loc.t('ไม่ควรอยู่ที่นี่')} ${_summary('unexpected')}\n\n'
          '${loc.t('ปิดรอบแล้วจะบันทึกผลลงระบบ และเพิ่มสแกนอีกไม่ได้')}',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(loc.t('ยกเลิก'))),
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(loc.t('ปิดรอบ'))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await _c.api.closeCycleCount(session['id'].toString());
      if (!mounted) return;
      _c.toastMsg('บันทึกผลตรวจนับแล้ว', '${session['id']}', ResultKind.ok);
      setState(() {
        _session = null;
        _pending.clear();
      });
    } catch (e) {
      if (!mounted) return;
      setState(
          () => _error = e is ApiException ? e.message : _c.errorMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final session = _session;
    final zones = _zonesInWh(c);
    final counted = _list('counted');
    final missing = _list('missing');
    final unexpected = _list('unexpected');

    return AutoHideHeader(
      header: StickyHeader(
        onBack: c.backToHome,
        title: Text(loc.t('ตรวจนับ')),
        subtitle: Text(session == null
            ? c.selWhName
            : '${session['id']} · ${c.selWhName}${(session['zone'] ?? '').toString().isNotEmpty ? ' · ${loc.t('โซน')} ${session['zone']}' : ''}'),
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
              children: [
                if (_error != null) ...[
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 13, vertical: 11),
                    decoration: BoxDecoration(
                      color: C.redBg,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: C.redBorder),
                    ),
                    child: Text(_error!,
                        style: TextStyle(
                            fontSize: 12.5, color: C.red, height: 1.4)),
                  ),
                  const SizedBox(height: 12),
                ],
                if (session == null) ...[
                  if (zones.isNotEmpty) ...[
                    Text(loc.t('เลือกโซนที่จะตรวจนับ'),
                        style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: C.muted)),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        _zoneChip(loc.t('ทั้งคลัง'), _zone == null,
                            () => setState(() => _zone = null)),
                        ...zones.map((z) => _zoneChip(
                            z, _zone == z, () => setState(() => _zone = z))),
                      ],
                    ),
                    const SizedBox(height: 16),
                  ],
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _busy ? null : _start,
                      style: FilledButton.styleFrom(
                        backgroundColor: C.ink,
                        padding: const EdgeInsets.symmetric(vertical: 15),
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12)),
                      ),
                      child: Text(
                          _busy ? loc.t('กำลังเริ่ม…') : loc.t('เริ่มตรวจนับ')),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                      loc.t(
                          'รอบตรวจนับจะถูกบันทึกลงระบบ — ถ้ามีคนเริ่มรอบของโซนนี้ค้างไว้ ระบบจะทำต่อรอบเดิมให้'),
                      style: TextStyle(
                          fontSize: 11.5, color: C.faint, height: 1.45)),
                ] else ...[
                  TextField(
                    controller: _scanCtrl,
                    focusNode: _scanFocus,
                    autofocus: true,
                    textCapitalization: TextCapitalization.characters,
                    autocorrect: false,
                    enableSuggestions: false,
                    onChanged: (_) => _onScanChanged(),
                    onSubmitted: (_) => _submitScan(_scanCtrl.text.trim()),
                    style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        fontFamily: 'monospace'),
                    decoration: InputDecoration(
                      hintText: loc.t('ยิงบาร์โค้ด หรือพิมพ์รหัส'),
                      hintStyle: TextStyle(
                          fontFamily: 'Roboto', color: C.faint, fontSize: 15),
                      prefixIcon: Icon(Icons.checklist, color: C.muted),
                      suffixIcon: _busy
                          ? const Padding(
                              padding: EdgeInsets.all(13),
                              child: SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                      strokeWidth: 2)),
                            )
                          : null,
                      isDense: true,
                      filled: true,
                      fillColor: C.surface,
                      border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(14),
                          borderSide:
                              BorderSide(color: C.fieldBorder, width: 1.5)),
                      enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(14),
                          borderSide:
                              BorderSide(color: C.fieldBorder, width: 1.5)),
                      focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(14),
                          borderSide: BorderSide(color: C.ink, width: 1.5)),
                    ),
                  ),
                  if (_pending.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text('${loc.t('รอส่งเข้าระบบ')} ${_pending.length}',
                        style: TextStyle(
                            fontSize: 11.5,
                            color: C.orange,
                            fontWeight: FontWeight.w600)),
                  ],
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      Expanded(
                          child: _CountStat(
                              value: '${_summary('expected')}',
                              label: loc.t('คาดว่ามี'),
                              color: C.ink)),
                      const SizedBox(width: 9),
                      Expanded(
                          child: _CountStat(
                              value: '${_summary('counted')}',
                              label: loc.t('พบแล้ว'),
                              color: C.menuGreen)),
                      const SizedBox(width: 9),
                      Expanded(
                          child: _CountStat(
                              value: '${_summary('missing')}',
                              label: loc.t('ยังไม่พบ'),
                              color: C.menuOrange)),
                    ],
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _busy ? null : _close,
                      style: FilledButton.styleFrom(
                        backgroundColor: C.lime,
                        foregroundColor: C.limeDeep,
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12)),
                      ),
                      child: Text(loc.t('ปิดรอบและบันทึกผล'),
                          style: const TextStyle(
                              fontSize: 15, fontWeight: FontWeight.w800)),
                    ),
                  ),
                  if (unexpected.isNotEmpty) ...[
                    const SizedBox(height: 14),
                    Caption(loc.t('ไม่ควรอยู่ที่นี่')),
                    const SizedBox(height: 8),
                    ...unexpected.map((tag) => _rowTile(
                          tag: tag,
                          sub: _typeOf(c, tag),
                          color: C.red,
                          icon: Icons.error_outline,
                        )),
                  ],
                  if (missing.isNotEmpty) ...[
                    const SizedBox(height: 14),
                    Caption(loc.t('ยังไม่พบ')),
                    const SizedBox(height: 8),
                    ...missing.map((tag) => _rowTile(
                          tag: tag,
                          sub: _typeOf(c, tag),
                          color: C.faint,
                          icon: Icons.radio_button_unchecked,
                        )),
                  ],
                  if (counted.isNotEmpty) ...[
                    const SizedBox(height: 14),
                    Caption(loc.t('พบแล้ว')),
                    const SizedBox(height: 8),
                    ...counted.map((tag) => _rowTile(
                          tag: tag,
                          sub: _typeOf(c, tag),
                          color: C.menuGreen,
                          icon: Icons.check_circle,
                        )),
                  ],
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _typeOf(AppController c, String tag) {
    final b = c.S?.box(tag);
    return b == null ? '' : (c.S?.typeName(b.type) ?? '');
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
            style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: selected ? C.surface : C.ink2)),
      ),
    );
  }

  Widget _rowTile(
      {required String tag,
      required String sub,
      required Color color,
      required IconData icon}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
        decoration: BoxDecoration(
            color: C.surface,
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: C.border)),
        child: Row(
          children: [
            Icon(icon, size: 18, color: color),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(tag,
                      style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          fontFamily: 'monospace')),
                  if (sub.isNotEmpty)
                    Text(sub, style: TextStyle(fontSize: 11.5, color: C.muted)),
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
  const _CountStat(
      {required this.value, required this.label, required this.color});
  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(value,
              style: TextStyle(
                  fontSize: 22, fontWeight: FontWeight.w700, color: color)),
          Text(label,
              style: TextStyle(
                  fontSize: 11, color: C.muted, fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }
}
