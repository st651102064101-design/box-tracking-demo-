import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// "ย้ายตำแหน่ง" — relocate boxes already sitting in the warehouse to a new
/// zone/rack/shelf/slot. Reuses [ApiClient.putawayBox] (the same call
/// BoxRegisterScreen's putaway step makes) rather than a dedicated transfer
/// endpoint — the backend already logs a 'relocate' history entry instead of
/// 'putaway' whenever the box's status is already 'warehouse'.
///
/// Two ways to pick what's moving:
///  - บาร์โค้ด: one box at a time, either scanned/typed or chosen from a
///    searchable list, into one zone/rack/shelf/slot.
///  - RFID: sweep a pile at once — every distinct tag the trigger finds
///    (that's actually 'warehouse' status) joins a batch list. The batch
///    shares one zone + rack (the common case: moving a shelf's worth of
///    boxes to the same rack), but each box keeps its own shelf/slot picker,
///    since "same rack, different shelf/slot each" is exactly the case this
///    mode exists for.
class TransferScreen extends StatefulWidget {
  const TransferScreen({super.key});
  @override
  State<TransferScreen> createState() => _TransferScreenState();
}

class _TransferScreenState extends State<TransferScreen> {
  // ── barcode mode: single target ──────────────────────────────────────
  final _searchCtrl = TextEditingController();
  final _searchFocus = FocusNode();
  Timer? _autoSearchTimer;
  static const _autoSearchDelay = Duration(milliseconds: 180);
  static const _autoSearchMinLen = 3;
  int _prevLen = 0;

  Box? _target;
  String? _error;
  bool _saving = false;

  /// false = scan/type a code; true = browse a searchable list of boxes
  /// instead. Toggled by a small link above the input, not a full segmented
  /// control — this is the exception path (no scanner handy, or the code is
  /// worn off), not a coin-flip choice made every time.
  bool _pickFromList = false;
  final _listSearchCtrl = TextEditingController();

  /// The destination, and the only way it can ever be set: scanned off the
  /// shelf's own barcode (see [LocationScanField]). Null until then, which is
  /// what keeps the confirm button disabled.
  Map<String, String>? _dest;

  // ── RFID mode: bulk select ────────────────────────────────────────────
  StreamSubscription<bool>? _triggerSub;
  bool _reading = false;
  final Set<String> _excluded = {}; // tags unchecked out of the sweep result
  bool _bulkSaving = false;
  int _bulkDone = 0;
  String? _bulkError;

  /// One scanned destination for the whole sweep. Per-box shelf/slot pickers
  /// used to live here, but they were pickers — the thing this screen no
  /// longer has. A batch going to different shelves is now several sweeps,
  /// one per shelf, which is also what actually happens physically.
  Map<String, String>? _bulkDest;

  AppController get _c => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _searchFocus.requestFocus());
    _triggerSub = _c.rfid.triggers.listen((pressed) {
      if (mounted) setState(() => _reading = pressed);
    });
  }

  @override
  void dispose() {
    _autoSearchTimer?.cancel();
    _searchCtrl.dispose();
    _searchFocus.dispose();
    _listSearchCtrl.dispose();
    _triggerSub?.cancel();
    // Leaving mid-sweep must not leave the antenna running in the
    // background, and a stale batch from this visit has no business
    // surviving into the next one.
    _c.rfid.stopInventory();
    _c.transferRfidHits.clear();
    super.dispose();
  }

  void _setMode(AppController c, ScanInputMode m) {
    if (c.scanInputMode == m) return;
    c.setScanInputMode(m);
    c.transferRfidHits.clear();
    _excluded.clear();
    _bulkDest = null;
    _bulkError = null;
    if (m == ScanInputMode.barcode) {
      WidgetsBinding.instance
          .addPostFrameCallback((_) => _searchFocus.requestFocus());
    } else {
      _searchFocus.unfocus();
    }
    setState(() {});
  }

  // ── barcode: single target ────────────────────────────────────────────
  void _onSearchChanged() {
    _autoSearchTimer?.cancel();
    final text = _searchCtrl.text.trim();
    final addedChars = _searchCtrl.text.length - _prevLen;
    _prevLen = _searchCtrl.text.length;
    if (text.isEmpty) return;
    if (text.length < _autoSearchMinLen) return;
    // Same burst-detection as track_screen/rfid_locate_screen: a scan lands
    // as more than one new character in a single callback, which commits
    // immediately instead of waiting out the debounce.
    if (addedChars > 1) {
      _resolve(text);
      return;
    }
    _autoSearchTimer = Timer(_autoSearchDelay, () {
      if (!mounted || _searchCtrl.text.trim() != text) return;
      _resolve(text);
    });
  }

  void _resolve(String raw) {
    final c = _c;
    final tag = c.resolveTag(raw);
    final b = c.S?.box(tag);
    if (b == null) {
      setState(() => _error = 'ไม่พบกล่อง "$raw" ในระบบ');
      return;
    }
    if (b.status != 'warehouse') {
      setState(() => _error =
          'ย้ายตำแหน่งได้เฉพาะกล่องที่อยู่ในคลังเท่านั้น (สถานะปัจจุบัน: ${StatusMeta.of(b.status).label})');
      return;
    }
    setState(() {
      _target = b;
      _error = null;
      _pickFromList = false;
      _dest = null;
    });
  }

  void _changeTarget() {
    setState(() {
      _target = null;
      _error = null;
      _pickFromList = false;
      _searchCtrl.clear();
      _listSearchCtrl.clear();
      _prevLen = 0;
      _dest = null;
    });
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _searchFocus.requestFocus());
  }

  Future<void> _submitSingle() async {
    final c = _c;
    final b = _target;
    if (b == null || _dest == null || _saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final d = _dest!;
      await c.api.putawayBox(b.tag,
          wh: c.wh,
          zone: d['zone'] ?? '',
          rack: d['rack'] ?? '',
          shelf: d['shelf'] ?? '',
          slot: d['slot'] ?? '');
      if (!mounted) return;
      c.toastMsg('ย้ายตำแหน่งแล้ว', b.tag, ResultKind.ok);
      _changeTarget();
    } catch (e) {
      setState(
          () => _error = e is ApiException ? e.message : c.errorMessage(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ── RFID: bulk transfer ────────────────────────────────────────────────
  Future<void> _submitBulk() async {
    final c = _c;
    final tags =
        c.transferRfidHits.where((t) => !_excluded.contains(t)).toList();
    if (tags.isEmpty || _bulkDest == null || _bulkSaving) return;
    setState(() {
      _bulkSaving = true;
      _bulkDone = 0;
      _bulkError = null;
    });
    final failed = <String>[];
    for (final tag in tags) {
      try {
        await c.api.putawayBox(
          tag,
          wh: c.wh,
          zone: _bulkDest!['zone'] ?? '',
          rack: _bulkDest!['rack'] ?? '',
          shelf: _bulkDest!['shelf'] ?? '',
          slot: _bulkDest!['slot'] ?? '',
        );
        if (mounted) setState(() => _bulkDone++);
      } catch (_) {
        failed.add(tag);
      }
    }
    if (!mounted) return;
    if (failed.isEmpty) {
      c.toastMsg('ย้ายตำแหน่งแล้ว', '${tags.length} กล่อง', ResultKind.ok);
      setState(() {
        c.transferRfidHits.clear();
        _excluded.clear();
        _bulkDest = null;
        _bulkSaving = false;
      });
    } else {
      setState(() {
        _bulkError =
            'ย้ายไม่สำเร็จ ${failed.length}/${tags.length} กล่อง: ${failed.join(', ')}';
        _bulkSaving = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final isRfid = c.scanInputMode == ScanInputMode.rfid;

    return AutoHideHeader(
      header: StickyHeader(
        onBack: c.backToHome,
        title: Text(loc.t('ย้ายตำแหน่ง')),
        subtitle: Text(loc.t(isRfid
            ? 'เหนี่ยวไกเพื่อกวาดหลายกล่องพร้อมกัน'
            : 'ยิงหรือพิมพ์รหัสกล่องที่จะย้าย')),
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
              children: [
                _modeToggle(c, loc),
                const SizedBox(height: 11),
                if (!isRfid) ..._barcodeBody(c, loc) else ..._rfidBody(c, loc),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _modeToggle(AppController c, LocaleController loc) {
    Widget seg(ScanInputMode m, String label, IconData icon) {
      final selected = c.scanInputMode == m;
      return Expanded(
        child: GestureDetector(
          onTap: () => _setMode(c, m),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 9),
            decoration: BoxDecoration(
              color: selected ? C.ink : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 15, color: selected ? C.surface : C.ink2),
                const SizedBox(width: 6),
                Text(label,
                    style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: selected ? C.surface : C.ink2)),
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
          color: C.neutralBg2, borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          seg(ScanInputMode.barcode, loc.t('บาร์โค้ด'), Icons.qr_code_scanner),
          seg(ScanInputMode.rfid, 'RFID (${loc.t('หลายกล่อง')})',
              Icons.wifi_tethering),
        ],
      ),
    );
  }

  // ── barcode-mode body ──────────────────────────────────────────────────
  List<Widget> _barcodeBody(AppController c, LocaleController loc) {
    final b = _target;
    if (b == null) {
      return [
        Row(
          children: [
            Expanded(
              child: Text(
                  loc.t(_pickFromList
                      ? 'เลือกกล่องจากรายการ'
                      : 'ยิงหรือพิมพ์รหัสกล่อง'),
                  style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: C.muted)),
            ),
            GestureDetector(
              onTap: () => setState(() => _pickFromList = !_pickFromList),
              child: Text(
                  loc.t(_pickFromList ? 'ยิงบาร์โค้ดแทน' : 'เลือกจากรายการแทน'),
                  style: TextStyle(
                      fontSize: 12.5,
                      color: C.ink2,
                      fontWeight: FontWeight.w600)),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (_pickFromList) ..._listPicker(c, loc) else _scanField(loc),
        if (_error != null) ...[
          const SizedBox(height: 10),
          Text(_error!,
              style: TextStyle(
                  fontSize: 13, color: C.red, fontWeight: FontWeight.w600)),
        ],
      ];
    }
    return [
      Panel(
        padding: const EdgeInsets.all(16),
        radius: 18,
        child: Row(
          children: [
            Container(
              width: 46,
              height: 46,
              decoration: BoxDecoration(
                  color: C.neutralBg2, borderRadius: BorderRadius.circular(13)),
              child: Icon(Icons.inventory_2_outlined, size: 24, color: C.ink2),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(b.tag,
                      style: const TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w700,
                          fontFamily: 'monospace')),
                  Text(
                      '${c.S?.typeName(b.type) ?? ''} · ${c.S?.whName(b.location['wh']?.toString()) ?? ''}',
                      style: TextStyle(fontSize: 12, color: C.muted)),
                ],
              ),
            ),
            GestureDetector(
              onTap: _changeTarget,
              child: Text(loc.t('เปลี่ยนกล่อง'),
                  style: TextStyle(
                      fontSize: 12.5,
                      color: C.ink2,
                      fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      ),
      const SizedBox(height: 14),
      Panel(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${loc.t('ตำแหน่งใหม่')} · ${c.selWhName}',
                style:
                    const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(loc.t('ยิงบาร์โค้ดของชั้นวางที่จะนำกล่องไปวาง'),
                style: TextStyle(fontSize: 12, color: C.muted)),
            const SizedBox(height: 10),
            if (_dest == null)
              LocationScanField(
                controller: c,
                loc: loc,
                onConfirmed: (l) => setState(() => _dest = l),
              )
            else
              _confirmedLocationCard(
                  loc, _dest!, () => setState(() => _dest = null)),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: TextStyle(fontSize: 12.5, color: C.red)),
            ],
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: (_dest == null || _saving) ? null : _submitSingle,
                style: FilledButton.styleFrom(
                  backgroundColor: C.ink,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
                child: Text(_saving
                    ? loc.t('กำลังบันทึก…')
                    : loc.t('ยืนยันย้ายตำแหน่ง')),
              ),
            ),
          ],
        ),
      ),
    ];
  }

  Widget _scanField(LocaleController loc) {
    return TextField(
      controller: _searchCtrl,
      focusNode: _searchFocus,
      textCapitalization: TextCapitalization.characters,
      autocorrect: false,
      enableSuggestions: false,
      onChanged: (_) => _onSearchChanged(),
      onSubmitted: (_) => _resolve(_searchCtrl.text.trim()),
      style: const TextStyle(
          fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
      decoration: InputDecoration(
        hintText: loc.t('รหัสกล่อง เช่น CRT-01'),
        hintStyle:
            TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 15),
        prefixIcon: Icon(Icons.sync_alt, color: C.muted),
        isDense: true,
        filled: true,
        fillColor: C.surface,
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: BorderSide(color: C.fieldBorder, width: 1.5)),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: BorderSide(color: C.fieldBorder, width: 1.5)),
        focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: BorderSide(color: C.ink, width: 1.5)),
      ),
    );
  }

  List<Widget> _listPicker(AppController c, LocaleController loc) {
    final q = _listSearchCtrl.text.trim().toLowerCase();
    final all = c.S?.boxes
            .where((b) => b.status == 'warehouse' && b.location['wh'] == c.wh)
            .toList() ??
        const <Box>[];
    final results = q.isEmpty
        ? all
        : all.where((b) {
            final type = c.S!.typeName(b.type).toLowerCase();
            return b.tag.toLowerCase().contains(q) || type.contains(q);
          }).toList();
    return [
      TextField(
        controller: _listSearchCtrl,
        autofocus: true,
        textCapitalization: TextCapitalization.characters,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          hintText: loc.t('พิมพ์รหัสหรือประเภทกล่อง'),
          prefixIcon: Icon(Icons.search, color: C.muted),
          isDense: true,
          filled: true,
          fillColor: C.surface,
          border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(14),
              borderSide: BorderSide(color: C.fieldBorder, width: 1.5)),
        ),
      ),
      const SizedBox(height: 10),
      Container(
        constraints: const BoxConstraints(maxHeight: 320),
        decoration: BoxDecoration(
            color: C.surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: C.border)),
        clipBehavior: Clip.antiAlias,
        child: results.isEmpty
            ? Padding(
                padding: const EdgeInsets.symmetric(vertical: 24),
                child: Center(
                    child: Text(loc.t('ไม่พบกล่อง'),
                        style: TextStyle(fontSize: 13, color: C.faint))),
              )
            : ListView.builder(
                shrinkWrap: true,
                itemCount: results.length,
                itemBuilder: (context, i) {
                  final b = results[i];
                  return InkWell(
                    onTap: () => _resolve(b.tag),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 12),
                      decoration: BoxDecoration(
                        border: i == results.length - 1
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
                                        fontSize: 14,
                                        fontWeight: FontWeight.w700,
                                        fontFamily: 'monospace')),
                                Text(c.S!.typeName(b.type),
                                    style: TextStyle(
                                        fontSize: 12, color: C.muted)),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
      ),
    ];
  }

  // ── RFID-mode body ──────────────────────────────────────────────────────
  List<Widget> _rfidBody(AppController c, LocaleController loc) {
    final hits = c.transferRfidHits;
    final selected = hits.where((t) => !_excluded.contains(t)).toList();
    return [
      Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 18),
        decoration: BoxDecoration(
          color: _reading ? C.limeBg : C.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
              color: _reading ? C.limeBorder : C.fieldBorder, width: 1.5),
        ),
        child: Column(
          children: [
            Icon(Icons.wifi_tethering,
                size: 22, color: _reading ? C.limeDeep : C.muted),
            const SizedBox(height: 6),
            Text(
              loc.t(_reading
                  ? 'กำลังกวาดหา…'
                  : 'เหนี่ยวไกเพื่อกวาดหากล่องหลายใบพร้อมกัน'),
              style: TextStyle(
                  fontSize: 13,
                  color: _reading ? C.limeDeep : C.muted,
                  fontWeight: FontWeight.w600),
            ),
          ],
        ),
      ),
      const SizedBox(height: 14),
      if (hits.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Text(
              loc.t('ยังไม่พบกล่อง — เหนี่ยวไกกวาดเหนือกองกล่องที่จะย้าย'),
              style: TextStyle(fontSize: 12.5, color: C.faint)),
        )
      else ...[
        Row(
          children: [
            Expanded(
              child: Text(
                  '${loc.t('พบ')} ${hits.length} ${loc.t('กล่อง')} · ${loc.t('เลือกย้าย')} ${selected.length}',
                  style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: C.muted)),
            ),
            GestureDetector(
              onTap: () => setState(() {
                c.transferRfidHits.clear();
                _excluded.clear();
              }),
              child: Text(loc.t('ล้างรายการ'),
                  style: TextStyle(
                      fontSize: 12.5,
                      color: C.orange,
                      fontWeight: FontWeight.w600)),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Panel(
          padding: const EdgeInsets.all(14),
          radius: 16,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${loc.t('ตำแหน่งใหม่ (ทั้งหมด)')} · ${c.selWhName}',
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text(
                  loc.t(
                      'ทั้งชุดไปที่ช่องเดียวกัน — ถ้าคนละช่อง ให้กวาดแยกทีละช่อง'),
                  style: TextStyle(fontSize: 11, color: C.faint)),
              const SizedBox(height: 10),
              if (_bulkDest == null)
                LocationScanField(
                  controller: c,
                  loc: loc,
                  autofocus: false,
                  onConfirmed: (l) => setState(() => _bulkDest = l),
                )
              else
                _confirmedLocationCard(
                    loc, _bulkDest!, () => setState(() => _bulkDest = null)),
            ],
          ),
        ),
        const SizedBox(height: 10),
        ...hits.map((tag) {
          final b = c.S?.box(tag);
          final excluded = _excluded.contains(tag);
          return Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: excluded ? C.neutralBg : C.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: C.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Checkbox(
                        value: !excluded,
                        onChanged: (v) => setState(() {
                          if (v == true) {
                            _excluded.remove(tag);
                          } else {
                            _excluded.add(tag);
                          }
                        }),
                        activeColor: C.limeDeep,
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(tag,
                                style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w700,
                                    fontFamily: 'monospace',
                                    color: excluded ? C.faint : C.ink)),
                            if (b != null)
                              Text(c.S!.typeName(b.type),
                                  style: TextStyle(
                                      fontSize: 11.5, color: C.muted)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        }),
        if (_bulkError != null) ...[
          const SizedBox(height: 10),
          Text(_bulkError!,
              style: TextStyle(fontSize: 12.5, color: C.red, height: 1.4)),
        ],
        const SizedBox(height: 6),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: (selected.isEmpty || _bulkDest == null || _bulkSaving)
                ? null
                : _submitBulk,
            style: FilledButton.styleFrom(
              backgroundColor: C.ink,
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12)),
            ),
            child: Text(_bulkSaving
                ? '${loc.t('กำลังบันทึก…')} ($_bulkDone/${selected.length})'
                : '${loc.t('ย้ายทั้งหมด')} (${selected.length})'),
          ),
        ),
      ],
    ];
  }

  /// A scanned destination, shown back with a way to clear it. Clearing
  /// returns to the scan field — the only route to a location on this screen.
  Widget _confirmedLocationCard(
      LocaleController loc, Map<String, String> dest, VoidCallback onClear) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: C.limeBg,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: C.limeBorder, width: 1.5),
      ),
      child: Row(
        children: [
          Icon(Icons.check_circle, size: 19, color: C.limeDeep),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(loc.t('ยืนยันช่องแล้ว'),
                    style: TextStyle(
                        fontSize: 11.5,
                        color: C.limeDeep,
                        fontWeight: FontWeight.w600)),
                Text(locationText(dest),
                    style: const TextStyle(
                        fontSize: 18, fontWeight: FontWeight.w800)),
              ],
            ),
          ),
          GestureDetector(
            onTap: onClear,
            child: Text(loc.t('ยิงใหม่'),
                style: TextStyle(
                    fontSize: 12.5,
                    color: C.ink2,
                    fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}
