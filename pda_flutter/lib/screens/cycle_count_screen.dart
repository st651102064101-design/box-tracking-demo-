import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_capture.dart';

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
  /// Scope pick before a session opens.
  /// `null` = not chosen yet · `''` = whole warehouse · otherwise a zone id.
  String? _pick;

  bool _busy = false;
  String? _error;

  /// The open session, straight from the server. Null until one is started.
  Map<String, dynamic>? _session;

  /// How many entries of AppController.cycleCountRfidHits have already been
  /// submitted — that list only ever grows (see _onReaderTag's
  /// Screen.cycleCount case), so "new since last build" is everything past
  /// this index, not the whole list every time.
  int _consumedRfidHits = 0;

  /// Tags queued locally because a scan landed while offline or while another
  /// post was still in flight — flushed on the next successful post so a dead
  /// zone doesn't silently drop reads.
  final List<String> _pending = [];

  /// Missing-count seen on the previous build, so the completion celebration
  /// fires only on the transition into "nothing missing" — not on every
  /// rebuild of an already-complete session, and not the instant a session
  /// is resumed already complete from a previous shift.
  int? _lastMissing;

  AppController get _c => context.read<AppController>();

  List<Box> _boxesInWh(AppController c) {
    return c.S?.boxes
            .where((b) => b.status == 'warehouse' && b.location['wh'] == c.wh)
            .toList() ??
        const <Box>[];
  }

  List<String> _zonesInWh(AppController c) {
    final zones = _boxesInWh(c)
        .map((b) => (b.location['zone'] ?? '').toString())
        .where((z) => z.isNotEmpty)
        .toSet()
        .toList()
      ..sort();
    return zones;
  }

  int _previewCount(AppController c) {
    final boxes = _boxesInWh(c);
    if (_pick == null) return 0;
    if (_pick!.isEmpty) return boxes.length;
    return boxes
        .where((b) => (b.location['zone'] ?? '').toString() == _pick)
        .length;
  }

  int _zoneCount(AppController c, String zone) {
    return _boxesInWh(c)
        .where((b) => (b.location['zone'] ?? '').toString() == zone)
        .length;
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
    if (_busy || _pick == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final s = await _c.api.openCycleCount(wh: _c.wh, zone: _pick ?? '');
      if (!mounted) return;
      setState(() => _session = s);
      if (s['resumed'] == true) {
        _c.toastMsg('ทำต่อรอบเดิม', '${s['id']}', ResultKind.info);
      }
      // Nothing to focus by hand any more — ScanCapture arms itself the
      // moment the session exists (see the enabled flag in build).
    } catch (e) {
      if (!mounted) return;
      setState(
          () => _error = e is ApiException ? e.message : _c.errorMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submitScan(String raw) async {
    final session = _session;
    if (session == null || raw.isEmpty) return;
    // Codes go up as scanned — the server resolves barcode/EPC/TID itself, so
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

  /// Plays a one-shot confetti burst over the whole screen and shows a
  /// formal congratulatory alert — fired from build() exactly once, on the
  /// transition into "nothing missing" (see _lastMissing).
  void _celebrateComplete(LocaleController loc) {
    if (!mounted) return;
    final overlay = Overlay.of(context, rootOverlay: true);
    late OverlayEntry entry;
    entry = OverlayEntry(
      builder: (_) => _ConfettiBurst(onDone: () => entry.remove()),
    );
    overlay.insert(entry);
    showDialog<void>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        icon: Icon(Icons.emoji_events, color: C.lime, size: 40),
        title: Text(loc.t('ตรวจนับครบถ้วน')),
        content: Text(
          loc.t(
              'ขอแสดงความยินดี ท่านได้ดำเนินการตรวจนับครบถ้วนทุกรายการที่คาดไว้เรียบร้อยแล้ว'),
          textAlign: TextAlign.center,
        ),
        actions: [
          Center(
            child: FilledButton(
              onPressed: () => Navigator.of(dialogCtx).pop(),
              style: FilledButton.styleFrom(backgroundColor: C.ink),
              child: Text(loc.t('รับทราบ')),
            ),
          ),
        ],
      ),
    );
  }

  /// Feeds any AppController.cycleCountRfidHits entries this screen hasn't
  /// posted yet through the same _submitScan a barcode read uses — called
  /// post-frame (build() must stay side-effect-free) whenever build() sees
  /// the hit list grew. Mirrors goCycleCount()'s cycleCountRfidHits.clear():
  /// if the list is ever shorter than what's already been consumed (a fresh
  /// session start while this screen never left), consumption resets too
  /// instead of going negative.
  void _drainRfidHits(AppController c) {
    final hits = c.cycleCountRfidHits;
    if (hits.length < _consumedRfidHits) _consumedRfidHits = 0;
    if (hits.length <= _consumedRfidHits) return;
    final fresh = hits.sublist(_consumedRfidHits);
    _consumedRfidHits = hits.length;
    for (final epc in fresh) {
      _submitScan(epc);
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
    final whBoxes = _boxesInWh(c).length;
    final preview = _previewCount(c);

    if (session != null && c.cycleCountRfidHits.length > _consumedRfidHits) {
      WidgetsBinding.instance
          .addPostFrameCallback((_) => _drainRfidHits(c));
    }

    if (session != null) {
      final expectedCount = _summary('expected');
      final missingCount = _summary('missing');
      // Fires only on the transition into zero-missing — a session resumed
      // already complete from a previous shift, or a rebuild that just
      // redraws an already-celebrated session, must not replay the alert.
      if (_lastMissing != null &&
          _lastMissing! > 0 &&
          missingCount == 0 &&
          expectedCount > 0) {
        WidgetsBinding.instance
            .addPostFrameCallback((_) => _celebrateComplete(loc));
      }
      _lastMissing = missingCount;
    }

    final sessionZone = (session?['zone'] ?? '').toString();
    final sessionScope = session == null
        ? ''
        : sessionZone.isEmpty
            ? loc.t('ทั้งคลัง')
            : '${loc.t('โซน')} $sessionZone';

    return ScanCapture(
      // Live only once a session is open — the setup step above has zone
      // chips and a start button, and nothing to scan into yet.
      enabled: session != null,
      onScan: _submitScan,
      child: AutoHideHeader(
        header: StickyHeader(
          onBack: c.backToHome,
          title: Text(loc.t('ตรวจนับ')),
          subtitle: Text(session == null
              ? loc.t('เลือกขอบเขตในคลังปัจจุบัน')
              : '${session['id']} · $sessionScope'),
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
                    _warehouseContextCard(c, loc, whBoxes),
                    const SizedBox(height: 16),
                    Text(loc.t('เลือกขอบเขตที่จะตรวจนับ'),
                        style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w800,
                            color: C.ink)),
                    const SizedBox(height: 4),
                    Text(
                        loc.t(
                            'เลือกทั้งคลัง หรือเจาะจงโซน — แล้วกดเริ่มตรวจนับ'),
                        style: TextStyle(
                            fontSize: 12, color: C.muted, height: 1.4)),
                    const SizedBox(height: 12),
                    _scopeTile(
                      title: loc.t('ทั้งคลัง'),
                      subtitle: loc.t('นับกล่องทุกโซนในคลังนี้'),
                      countLabel: '$whBoxes ${loc.t('กล่อง')}',
                      selected: _pick != null && _pick!.isEmpty,
                      onTap: _busy
                          ? null
                          : () => setState(() => _pick = ''),
                    ),
                    if (zones.isNotEmpty) ...[
                      const SizedBox(height: 14),
                      Text(loc.t('หรือเลือกโซน'),
                          style: TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.w700,
                              color: C.muted)),
                      const SizedBox(height: 8),
                      ...zones.map((z) {
                        final n = _zoneCount(c, z);
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: _scopeTile(
                            title: '${loc.t('โซน')} $z',
                            subtitle: loc.t('นับเฉพาะกล่องในโซนนี้'),
                            countLabel: '$n ${loc.t('กล่อง')}',
                            selected: _pick == z,
                            onTap: _busy
                                ? null
                                : () => setState(() => _pick = z),
                          ),
                        );
                      }),
                    ] else ...[
                      const SizedBox(height: 10),
                      Text(
                          loc.t(
                              'ยังไม่มีโซนในคลังนี้ — เลือกทั้งคลังเพื่อเริ่มนับ'),
                          style: TextStyle(
                              fontSize: 12, color: C.faint, height: 1.4)),
                    ],
                    const SizedBox(height: 16),
                    if (_pick != null) ...[
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(
                            horizontal: 14, vertical: 12),
                        decoration: BoxDecoration(
                          color: C.limeBg,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: C.limeBorder),
                        ),
                        child: Text(
                          '${loc.t('จะเริ่มนับ')} · ${_pick!.isEmpty ? loc.t('ทั้งคลัง') : '${loc.t('โซน')} $_pick'} · $preview ${loc.t('กล่อง')}',
                          style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                              color: C.limeDeep,
                              height: 1.35),
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: (_busy || _pick == null) ? null : _start,
                        style: FilledButton.styleFrom(
                          backgroundColor: C.lime,
                          foregroundColor: C.limeDeep,
                          disabledBackgroundColor: C.neutralBg2,
                          disabledForegroundColor: C.faint,
                          padding: const EdgeInsets.symmetric(vertical: 15),
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12)),
                        ),
                        child: Text(
                            _busy
                                ? loc.t('กำลังเริ่ม…')
                                : loc.t('เริ่มตรวจนับ'),
                            style: const TextStyle(
                                fontSize: 15, fontWeight: FontWeight.w800)),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                        loc.t(
                            'รอบตรวจนับจะถูกบันทึกลงระบบ — ถ้ามีคนเริ่มรอบของขอบเขตนี้ค้างไว้ ระบบจะทำต่อรอบเดิมให้'),
                        style: TextStyle(
                            fontSize: 11.5, color: C.faint, height: 1.45)),
                  ] else ...[
                    _activeContextBanner(c, loc, sessionScope),
                    const SizedBox(height: 12),
                    ScanModeToggle(onChanged: (_) {}),
                    const SizedBox(height: 11),
                    // No field: the count is driven by the imager/antenna
                    // alone (see ScanCapture around this screen, and the RFID
                    // toggle above). A hand-typed code in a stock take is
                    // worse than a missed one — it reconciles a box that
                    // nobody actually saw on the shelf.
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(
                          horizontal: 15, vertical: 18),
                      decoration: BoxDecoration(
                        color: C.surface,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: C.fieldBorder, width: 1.5),
                      ),
                      child: Row(
                        children: [
                          Icon(
                              c.scanInputMode == ScanInputMode.rfid
                                  ? Icons.wifi_tethering
                                  : Icons.checklist,
                              color: C.muted),
                          const SizedBox(width: 11),
                          Expanded(
                            child: Text(
                                loc.t(c.scanInputMode == ScanInputMode.rfid
                                    ? 'กดไกค้างเพื่อกวาดหากล่องบนชั้น'
                                    : 'ยิงบาร์โค้ดกล่องที่พบบนชั้น'),
                                style: TextStyle(
                                    fontSize: 14,
                                    color: C.muted,
                                    fontWeight: FontWeight.w600)),
                          ),
                          if (_busy)
                            const SizedBox(
                                width: 16,
                                height: 16,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2)),
                        ],
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
      ),
    );
  }

  Widget _warehouseContextCard(
      AppController c, LocaleController loc, int boxCount) {
    final whName =
        c.selWhName.isEmpty ? loc.t('ยังไม่ได้เลือกคลัง') : c.selWhName;
    final gate = c.gate.isEmpty ? '—' : c.gate;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: C.border),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: C.limeBg,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(Icons.warehouse_outlined, color: C.limeDeep, size: 24),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(loc.t('คุณกำลังตรวจนับที่'),
                    style: TextStyle(fontSize: 11.5, color: C.muted)),
                const SizedBox(height: 2),
                Text(whName,
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(
                    '${loc.t('ประตู')} $gate · $boxCount ${loc.t('กล่องในคลัง')}',
                    style: TextStyle(fontSize: 12, color: C.muted)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _activeContextBanner(
      AppController c, LocaleController loc, String sessionScope) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: C.neutralBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: C.border2),
      ),
      child: Row(
        children: [
          Icon(Icons.place_outlined, size: 18, color: C.ink2),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '${c.selWhName} · $sessionScope',
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }

  Widget _scopeTile({
    required String title,
    required String subtitle,
    required String countLabel,
    required bool selected,
    required VoidCallback? onTap,
  }) {
    return Material(
      color: selected ? C.limeBg : C.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
                color: selected ? C.limeBorder : C.border2,
                width: selected ? 1.5 : 1),
          ),
          child: Row(
            children: [
              Icon(
                selected ? Icons.check_circle : Icons.radio_button_unchecked,
                size: 22,
                color: selected ? C.limeText : C.chevron,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 2),
                    Text(subtitle,
                        style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(countLabel,
                  style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w800,
                      color: selected ? C.limeDeep : C.ink2)),
            ],
          ),
        ),
      ),
    );
  }

  String _typeOf(AppController c, String tag) {
    final b = c.S?.box(tag);
    return b == null ? '' : (c.S?.typeName(b.type) ?? '');
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

/// One-shot confetti rain over the whole screen, inserted as a root overlay
/// entry from _celebrateComplete so it draws above the AlertDialog's own
/// barrier — a full-screen burst reads as "the whole app is celebrating",
/// not just the dialog card. Self-removes via [onDone] once the fall
/// animation finishes; not gated on C.lowGraphics like every other
/// animation in this app, since this plays once as a reward rather than on
/// every frame of routine chrome.
class _ConfettiBurst extends StatefulWidget {
  final VoidCallback onDone;
  const _ConfettiBurst({required this.onDone});
  @override
  State<_ConfettiBurst> createState() => _ConfettiBurstState();
}

class _ConfettiBurstState extends State<_ConfettiBurst>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  late final List<_ConfettiParticle> _particles;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 2200))
      ..addStatusListener((status) {
        if (status == AnimationStatus.completed) widget.onDone();
      })
      ..forward();
    final rnd = Random();
    _particles = List.generate(70, (_) => _ConfettiParticle(rnd));
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: AnimatedBuilder(
        animation: _ctrl,
        builder: (_, __) => CustomPaint(
          size: MediaQuery.of(context).size,
          painter: _ConfettiPainter(_particles, _ctrl.value),
        ),
      ),
    );
  }
}

class _ConfettiParticle {
  final double x0; // 0..1 horizontal start
  final double delay; // 0..0.35 stagger, so the burst doesn't fall as one flat sheet
  final double speed; // fall-speed multiplier
  final double drift; // horizontal sway amplitude in px
  final double size;
  final double rotSpeed;
  final Color color;

  _ConfettiParticle(Random rnd)
      : x0 = rnd.nextDouble(),
        delay = rnd.nextDouble() * 0.35,
        speed = 0.7 + rnd.nextDouble() * 0.6,
        drift = (rnd.nextDouble() - 0.5) * 40,
        size = 5 + rnd.nextDouble() * 5,
        rotSpeed = (rnd.nextDouble() - 0.5) * 8,
        color = _confettiColors[rnd.nextInt(_confettiColors.length)];
}

/// Pulled from C's own accent tokens rather than hardcoded — this way the
/// burst's palette shifts with the current theme (light/dark) the same as
/// everything else on screen, instead of clashing against a dark background.
List<Color> get _confettiColors =>
    [C.lime, C.orange, C.menuBlue, C.menuGreen, C.red];

class _ConfettiPainter extends CustomPainter {
  final List<_ConfettiParticle> particles;
  final double t; // overall animation progress, 0..1
  _ConfettiPainter(this.particles, this.t);

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint();
    for (final p in particles) {
      final local = ((t - p.delay) / (1 - p.delay)).clamp(0.0, 1.0);
      if (local <= 0) continue;
      final fallY = local * p.speed * size.height * 1.15;
      final dx = p.x0 * size.width + sin(local * pi * 2) * p.drift;
      final dy = -20 + fallY;
      if (dy > size.height + 20) continue;
      final fadeOut = local > 0.85 ? (1 - local) / 0.15 : 1.0;
      paint.color = p.color.withValues(alpha: fadeOut.clamp(0.0, 1.0));
      canvas.save();
      canvas.translate(dx, dy);
      canvas.rotate(local * p.rotSpeed);
      canvas.drawRect(
        Rect.fromCenter(
            center: Offset.zero, width: p.size, height: p.size * 0.6),
        paint,
      );
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(covariant _ConfettiPainter oldDelegate) => true;
}

