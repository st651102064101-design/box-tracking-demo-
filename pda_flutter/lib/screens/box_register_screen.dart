import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/location.dart';
import '../services/api_client.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

enum _Step { create, label, rfid, putaway, success }

enum _LocInputMode { scan, manual }

/// One distinct tag the RFID sweep turned up — same shape/reasoning as
/// RfidRegisterScreen's own _Candidate.
class _Candidate {
  final String epc;
  final int? rssi;
  final int hits;
  const _Candidate({required this.epc, this.rssi, required this.hits});
}

/// Receiving flow, start to finish: create the box row the moment it comes
/// off a supplier truck, confirm the barcode sticker's actually on it,
/// optionally commission an RFID tag, then put it away on an actual shelf.
/// Copied step-for-step from legacy.html's own box-registration handler
/// ($('#btnAddBox').onclick) and putaway modal — same lifecycle
/// (pending/unlabeled -> labeled -> warehouse), same history entries
/// (dir: reg/label/putaway), just one box at a time instead of the web's
/// desktop-only bulk-prefix generator.
class BoxRegisterScreen extends StatefulWidget {
  const BoxRegisterScreen({super.key});
  @override
  State<BoxRegisterScreen> createState() => _BoxRegisterScreenState();
}

class _BoxRegisterScreenState extends State<BoxRegisterScreen> {
  final _tagCtrl = TextEditingController();
  final _tagFocus = FocusNode();

  // Putaway location — cascading Zone/Rack/Shelf/Slot picked from the
  // Location Master, or filled in one shot by scanning a rack barcode.
  // Same two-mode pattern as legacy.html's locPickerHtml().
  _LocInputMode _locMode = _LocInputMode.scan;
  final _rackScanCtrl = TextEditingController();
  final _rackScanFocus = FocusNode();
  String? _locZone;
  String? _locRack;
  String? _locShelf;
  String? _locSlot;
  String? _locScanError;
  bool _locConfirmed = false;

  Timer? _autoSubmitTimer;
  static const _autoSubmitDelay = Duration(milliseconds: 180);
  static const _autoSubmitMinLen = 2;

  _Step _step = _Step.create;
  String? _selectedType;
  String? _tag; // confirmed once created
  String? _error;
  bool _creating = false;
  bool _labeling = false;
  bool _puttingAway = false;

  // RFID sweep — identical mechanics to RfidRegisterScreen.
  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<RfidStatus>? _statusSub;
  RfidStatus _rfidStatus = const RfidStatus(RfidState.idle, '');
  final List<_Candidate> _found = [];
  String? _selectedEpc;
  bool _binding = false;
  String? _rfidError;
  RfidService? _rfid;
  Timer? _successTimer;

  AppController get _c => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    final rfid = _c.rfid;
    _rfid = rfid;
    _rfidStatus = RfidStatus(rfid.state, '');
    _statusSub = rfid.status.listen((s) => setState(() => _rfidStatus = s));
    _tagSub = rfid.tagReads.listen(_onTagRead);
    if (rfid.supported && rfid.state != RfidState.connected) rfid.connect();
    _tagCtrl.addListener(_onTagChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _tagFocus.requestFocus());
  }

  @override
  void dispose() {
    _rfid?.stopInventory();
    _tagSub?.cancel();
    _statusSub?.cancel();
    _successTimer?.cancel();
    _autoSubmitTimer?.cancel();
    _tagCtrl.removeListener(_onTagChanged);
    _tagCtrl.dispose();
    _tagFocus.dispose();
    _rackScanCtrl.dispose();
    _rackScanFocus.dispose();
    super.dispose();
  }

  void _onTagChanged() {
    _autoSubmitTimer?.cancel();
    final text = _tagCtrl.text.trim();
    if (text.length < _autoSubmitMinLen || _creating || _selectedType == null) return;
    _autoSubmitTimer = Timer(_autoSubmitDelay, () {
      if (!mounted || _creating || _tagCtrl.text.trim() != text) return;
      _submitCreate();
    });
  }

  Future<void> _submitCreate() async {
    final tag = _tagCtrl.text.trim();
    final type = _selectedType;
    if (tag.isEmpty) {
      setState(() => _error = 'ยิงหรือพิมพ์บาร์โค้ดกล่อง');
      return;
    }
    if (type == null) {
      setState(() => _error = 'เลือกประเภทกล่องก่อน');
      return;
    }
    _autoSubmitTimer?.cancel();
    setState(() {
      _creating = true;
      _error = null;
    });
    try {
      final box = await _c.api.createBox(tag, type: type);
      setState(() {
        _tag = box['tag'] as String? ?? tag.toUpperCase();
        _step = _Step.label;
      });
    } catch (e) {
      setState(() => _error = e is ApiException ? e.message : 'สร้างกล่องไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  Future<void> _confirmLabel() async {
    final tag = _tag;
    if (tag == null || _labeling) return;
    setState(() {
      _labeling = true;
      _error = null;
    });
    try {
      await _c.api.labelBox(tag);
      setState(() => _step = _Step.rfid);
      // Same reasoning as RfidRegisterScreen: arm the reader the instant
      // this step opens rather than making the operator tap something
      // first — they're already holding the gun on this exact box.
      unawaited(_c.rfid.startInventory());
    } catch (e) {
      setState(() => _error = e is ApiException ? e.message : 'ยืนยันติดป้ายไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _labeling = false);
    }
  }

  void _onTagRead(RfidTagRead read) {
    if (_step != _Step.rfid || _binding) return;
    if (read.epc.isEmpty) return;
    setState(() {
      final existing = _found.indexWhere((c) => c.epc == read.epc);
      if (existing >= 0) {
        final c = _found[existing];
        _found[existing] = _Candidate(
          epc: c.epc,
          rssi: (read.rssi ?? -999) > (c.rssi ?? -999) ? read.rssi : c.rssi,
          hits: c.hits + 1,
        );
      } else {
        _found.insert(0, _Candidate(epc: read.epc, rssi: read.rssi, hits: 1));
      }
      _rfidError = null;
    });
  }

  Future<void> _bindSelected() async {
    final tag = _tag;
    final epc = _selectedEpc;
    if (tag == null || epc == null || _binding) return;
    setState(() {
      _binding = true;
      _rfidError = null;
    });
    unawaited(_c.rfid.stopInventory());
    try {
      await _c.api.associateRfid(tag, rfidEpc: epc, replace: true);
      _goPutaway();
    } catch (e) {
      setState(() => _rfidError = e is ApiException ? e.message : 'ผูกแท็กไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _binding = false);
    }
  }

  /// RFID commissioning is optional here (unlike RfidRegisterScreen, whose
  /// whole job is the tag) — a box can go straight from label to putaway
  /// without one and get tagged later from Home's own "ลงทะเบียนแท็ก RFID".
  void _skipRfid() {
    unawaited(_c.rfid.stopInventory());
    _goPutaway();
  }

  void _goPutaway() {
    if (!mounted) return;
    setState(() {
      _step = _Step.putaway;
      _found.clear();
      _selectedEpc = null;
      _locMode = _LocInputMode.scan;
      _locZone = null;
      _locRack = null;
      _locShelf = null;
      _locSlot = null;
      _locScanError = null;
      _locConfirmed = false;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _rackScanFocus.requestFocus());
  }

  LocationCascade get _locCascade => LocationCascade(_c.S?.locations ?? const {});

  void _applyRackScan() {
    final raw = _rackScanCtrl.text.trim();
    if (raw.isEmpty) return;
    final loc = _locCascade.resolveBarcode(raw, wh: _c.wh);
    if (loc == null) {
      setState(() => _locScanError = 'ไม่พบรหัสแร็ค "$raw" — ลองกรอกเองด้วยแท็บ "กรอกเอง"');
      _rackScanCtrl.clear();
      return;
    }
    setState(() {
      _locZone = loc.zone.isEmpty ? null : loc.zone;
      _locRack = loc.rack.isEmpty ? null : loc.rack;
      _locShelf = loc.shelf.isEmpty ? null : loc.shelf;
      _locSlot = loc.slot.isEmpty ? null : loc.slot;
      _locScanError = null;
      _locConfirmed = true;
    });
    _rackScanCtrl.clear();
  }

  void _resetLocPicker() {
    setState(() {
      _locConfirmed = false;
      _locScanError = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _rackScanFocus.requestFocus());
  }

  Future<void> _rescan() async {
    setState(() {
      _found.clear();
      _selectedEpc = null;
      _rfidError = null;
    });
    await _c.rfid.startInventory();
  }

  Future<void> _submitPutaway() async {
    final tag = _tag;
    if (tag == null || _puttingAway) return;
    if (_c.wh.isEmpty) {
      setState(() => _error = 'เครื่องนี้ยังไม่ได้เลือกคลัง');
      return;
    }
    setState(() {
      _puttingAway = true;
      _error = null;
    });
    try {
      await _c.api.putawayBox(
        tag,
        wh: _c.wh,
        zone: _locZone ?? '',
        rack: _locRack ?? '',
        shelf: _locShelf ?? '',
        slot: _locSlot ?? '',
      );
      final count = _c.prefs.bumpRfidRegisteredToday(_today);
      setState(() => _step = _Step.success);
      _c.toastMsg('รับกล่องเข้าคลังแล้ว', '$tag · วันนี้ $count กล่อง', ResultKind.ok);
      _successTimer?.cancel();
      _successTimer = Timer(const Duration(milliseconds: 1400), _resetForNextBox);
    } catch (e) {
      setState(() => _error = e is ApiException ? e.message : 'จัดเก็บไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _puttingAway = false);
    }
  }

  String get _today {
    final n = DateTime.now();
    return '${n.year.toString().padLeft(4, '0')}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
  }

  void _resetForNextBox() {
    if (!mounted) return;
    setState(() {
      _step = _Step.create;
      _tag = null;
      _error = null;
      _rfidError = null;
      _found.clear();
      _selectedEpc = null;
      _locMode = _LocInputMode.scan;
      _locZone = null;
      _locRack = null;
      _locShelf = null;
      _locSlot = null;
      _locScanError = null;
      _locConfirmed = false;
    });
    _rackScanCtrl.clear();
    _tagCtrl.clear();
    _tagFocus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final today = _c.prefs.rfidRegisteredToday(_today);

    return Column(
      children: [
        StickyHeader(onBack: c.backToHome, title: const Text('ลงทะเบียนกล่อง')),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 16),
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('รับเข้าสำเร็จวันนี้', style: TextStyle(fontSize: 13, color: C.muted)),
                  Text('$today กล่อง',
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: C.lime)),
                ],
              ),
              const SizedBox(height: 14),
              _stepper(),
              const SizedBox(height: 14),
              if (_step == _Step.create) _createCard(c),
              if (_step == _Step.label) _labelCard(),
              if (_step == _Step.rfid) _rfidCard(),
              if (_step == _Step.putaway) _putawayCard(c),
              if (_step == _Step.success) _successCard(),
              if (_error != null) ...[
                const SizedBox(height: 10),
                Text(_error!, style: TextStyle(fontSize: 12.5, color: C.red)),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _stepper() {
    final labels = ['สร้าง', 'ติดป้าย', 'RFID', 'Putaway'];
    final idx = switch (_step) {
      _Step.create => 0,
      _Step.label => 1,
      _Step.rfid => 2,
      _Step.putaway => 3,
      _Step.success => 4,
    };
    return Row(
      children: List.generate(labels.length, (i) {
        final done = i < idx;
        final current = i == idx;
        return Expanded(
          child: Row(
            children: [
              Expanded(
                child: Container(
                  height: 4,
                  margin: EdgeInsets.only(left: i == 0 ? 0 : 4, right: i == labels.length - 1 ? 0 : 4),
                  decoration: BoxDecoration(
                    color: done || current ? C.lime : C.neutralBg2,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
            ],
          ),
        );
      }),
    );
  }

  Widget _createCard(AppController c) {
    final types = c.S?.boxtypes.values.whereType<Map>().toList() ?? const [];
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: C.border2, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const FieldLabel('ประเภทกล่อง *'),
          DropdownButtonFormField<String>(
            initialValue: _selectedType,
            isExpanded: true,
            decoration: pdaInput('— เลือกประเภทกล่อง —', radius: 12),
            items: types.map((t) {
              final id = (t['id'] ?? '').toString();
              return DropdownMenuItem(value: id, child: Text('${t['name'] ?? id}', overflow: TextOverflow.ellipsis));
            }).toList(),
            onChanged: (v) => setState(() => _selectedType = v),
          ),
          const SizedBox(height: 12),
          const FieldLabel('บาร์โค้ดกล่องใหม่ *'),
          TextField(
            controller: _tagCtrl,
            focusNode: _tagFocus,
            autofocus: true,
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            enableSuggestions: false,
            enabled: !_creating,
            onSubmitted: (_) => _submitCreate(),
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
            decoration: InputDecoration(
              hintText: 'ยิงบาร์โค้ด หรือพิมพ์รหัสใหม่',
              hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 14),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
              filled: true,
              fillColor: C.neutralBg,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
              suffixIcon: _creating
                  ? const Padding(
                      padding: EdgeInsets.all(12),
                      child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                    )
                  : null,
            ),
          ),
          const SizedBox(height: 8),
          Text('เริ่มจากสร้างข้อมูลกล่อง — ยังไม่ใช่การจ่ายบาร์โค้ดจริง แค่บันทึกว่ากล่องนี้เข้าระบบแล้ว',
              style: TextStyle(fontSize: 11.5, color: C.muted, height: 1.4)),
        ],
      ),
    );
  }

  Widget _labelCard() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: C.limeBorder, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.check_circle, color: C.limeDeep, size: 18),
              const SizedBox(width: 8),
              Text('สร้างกล่องแล้ว', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
            ],
          ),
          const SizedBox(height: 8),
          Text(_tag ?? '',
              style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, fontFamily: 'monospace')),
          const SizedBox(height: 14),
          Text('ติดสติกเกอร์บาร์โค้ดที่ตัวกล่องแล้วกดยืนยัน',
              style: TextStyle(fontSize: 13, color: C.ink2, fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: _labeling ? null : _confirmLabel,
              style: FilledButton.styleFrom(
                backgroundColor: C.ink,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: Text(_labeling ? 'กำลังบันทึก…' : 'ยืนยันติดป้ายเสร็จแล้ว'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _rfidCard() {
    final connected = _rfidStatus.state == RfidState.connected || !_c.rfid.supported;
    Color dot = _binding ? C.limeDeep : C.orange;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: C.orangeBorder, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _RfidDot(color: dot, pulsing: !_binding),
              const SizedBox(width: 10),
              Expanded(
                child: Text(_binding ? 'กำลังผูกแท็ก…' : 'ผูกแท็ก RFID (ไม่บังคับ)',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
              ),
              if (!_binding)
                TextButton(
                  onPressed: _skipRfid,
                  style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: Size.zero),
                  child: Text('ข้าม', style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w700)),
                ),
            ],
          ),
          if (!connected)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('เครื่องอ่าน RFID ยังไม่พร้อม — ${_rfidStatus.message.isEmpty ? "กำลังเชื่อมต่อ…" : _rfidStatus.message}',
                  style: TextStyle(fontSize: 12, color: C.orange)),
            ),
          if (_rfidError != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_rfidError!, style: TextStyle(fontSize: 12.5, color: C.red)),
            ),
          if (!_binding) ...[
            const SizedBox(height: 12),
            if (_found.isEmpty)
              Text('ยังไม่พบแท็ก — เหนี่ยวไกหรือจ่อแท็กเข้าใกล้เครื่องอ่าน',
                  style: TextStyle(fontSize: 12.5, color: C.faint))
            else ...[
              Row(
                children: [
                  Expanded(
                    child: Text('พบ ${_found.length} แท็ก — เลือกใบที่จะผูก',
                        style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
                  ),
                  GestureDetector(
                    onTap: _rescan,
                    child: Text('ยิงใหม่', style: TextStyle(fontSize: 12.5, color: C.orange)),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              RadioGroup<String>(
                groupValue: _selectedEpc,
                onChanged: (v) => setState(() => _selectedEpc = v),
                child: Column(children: _found.map(_candidateRow).toList()),
              ),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _selectedEpc == null ? null : _bindSelected,
                  style: FilledButton.styleFrom(
                    backgroundColor: C.lime,
                    foregroundColor: C.limeDeep,
                    disabledBackgroundColor: C.neutralBg,
                    disabledForegroundColor: C.faint,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
                  ),
                  child: Text(
                    _selectedEpc == null ? 'เลือกแท็กที่จะผูก' : 'ผูกกับ ${_tag ?? ''}',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }

  Widget _candidateRow(_Candidate c) {
    final selected = _selectedEpc == c.epc;
    return InkWell(
      onTap: () => setState(() => _selectedEpc = c.epc),
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Radio<String>(
              value: c.epc,
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    c.epc,
                    style: TextStyle(
                      fontSize: 13,
                      fontFamily: 'monospace',
                      fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                      color: selected ? C.ink : C.ink2,
                    ),
                  ),
                  Text('สัญญาณ ${c.rssi ?? '—'} · อ่านได้ ${c.hits} ครั้ง',
                      style: TextStyle(fontSize: 11.5, color: C.faint)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _putawayCard(AppController c) {
    final cascade = _locCascade;
    final hasLocations = cascade.locations.isNotEmpty;
    final canSubmit = _locZone != null || _locRack != null || _locShelf != null || _locSlot != null;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: C.border2, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(_tag ?? '',
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, fontFamily: 'monospace')),
          const SizedBox(height: 4),
          Text('จัดเก็บที่ ${c.selWhName}', style: TextStyle(fontSize: 12.5, color: C.muted)),
          const SizedBox(height: 14),
          const FieldLabel('วิธีระบุตำแหน่ง'),
          _locModeToggle(),
          const SizedBox(height: 12),
          if (_locMode == _LocInputMode.scan) _locScanArea() else _locManualArea(cascade),
          if (!hasLocations)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text('ยังไม่มีข้อมูลผังชั้นวาง (Location Master) ในระบบ',
                  style: TextStyle(fontSize: 11.5, color: C.muted)),
            ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: (_puttingAway || !canSubmit) ? null : _submitPutaway,
              style: FilledButton.styleFrom(
                backgroundColor: C.lime,
                foregroundColor: C.limeDeep,
                disabledBackgroundColor: C.neutralBg,
                disabledForegroundColor: C.faint,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
              ),
              child: Text(_puttingAway ? 'กำลังบันทึก…' : 'จัดเก็บขึ้นแร็ค (Putaway)',
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _locModeToggle() {
    Widget seg(_LocInputMode m, String label, IconData icon) {
      final selected = _locMode == m;
      return Expanded(
        child: GestureDetector(
          onTap: () {
            if (_locMode == m) return;
            setState(() => _locMode = m);
            if (m == _LocInputMode.scan) {
              WidgetsBinding.instance.addPostFrameCallback((_) => _rackScanFocus.requestFocus());
            }
          },
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
      decoration: BoxDecoration(color: C.neutralBg2, borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          seg(_LocInputMode.scan, 'สแกนบาร์โค้ด', Icons.qr_code_scanner),
          seg(_LocInputMode.manual, 'กรอกเอง', Icons.list_alt),
        ],
      ),
    );
  }

  Widget _locScanArea() {
    if (_locConfirmed) {
      final label = [_locZone, _locRack, _locShelf, _locSlot].whereType<String>().join(' · ');
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: C.limeBg,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: C.limeBorder),
        ),
        child: Row(
          children: [
            Icon(Icons.check_circle, size: 18, color: C.limeDeep),
            const SizedBox(width: 10),
            Expanded(
              child: Text(label,
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800, fontFamily: 'monospace')),
            ),
            TextButton(
              onPressed: _resetLocPicker,
              style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: Size.zero),
              child: Text('เปลี่ยน', style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w700)),
            ),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: _rackScanCtrl,
          focusNode: _rackScanFocus,
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.characters,
          onSubmitted: (_) => _applyRackScan(),
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
          decoration: pdaInput('สแกนบาร์โค้ดป้ายแร็ค เช่น A-R03-2-05', radius: 12).copyWith(
            suffixIcon: IconButton(
              icon: const Icon(Icons.check),
              onPressed: _applyRackScan,
            ),
          ),
        ),
        if (_locScanError != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(_locScanError!, style: TextStyle(fontSize: 12, color: C.red)),
          ),
      ],
    );
  }

  Widget _locManualArea(LocationCascade cascade) {
    final wh = _c.wh;
    final zones = cascade.zones(wh);
    final racks = cascade.racks(wh, _locZone);
    final shelves = cascade.shelves(wh, _locZone, _locRack);
    final slots = cascade.slots(wh, _locZone, _locRack, _locShelf);

    String? clampedValue(String? current, List<String> options) =>
        (current != null && options.contains(current)) ? current : null;

    Widget dropdown(String label, String? value, List<String> options, void Function(String?) onChanged) {
      return Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            FieldLabel(label),
            DropdownButtonFormField<String>(
              initialValue: clampedValue(value, options),
              isExpanded: true,
              decoration: pdaInput('— ไม่ระบุ —', radius: 12),
              items: options
                  .map((v) => DropdownMenuItem(value: v, child: Text(v, overflow: TextOverflow.ellipsis)))
                  .toList(),
              onChanged: onChanged,
            ),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            dropdown('โซน', _locZone, zones, (v) {
              setState(() {
                _locZone = v;
                _locRack = null;
                _locShelf = null;
                _locSlot = null;
              });
            }),
            const SizedBox(width: 9),
            dropdown('แร็ค', _locRack, racks, (v) {
              setState(() {
                _locRack = v;
                _locShelf = null;
                _locSlot = null;
              });
            }),
          ],
        ),
        const SizedBox(height: 11),
        Row(
          children: [
            dropdown('ชั้น', _locShelf, shelves, (v) {
              setState(() {
                _locShelf = v;
                _locSlot = null;
              });
            }),
            const SizedBox(width: 9),
            dropdown('ช่อง', _locSlot, slots, (v) => setState(() => _locSlot = v)),
          ],
        ),
      ],
    );
  }

  Widget _successCard() {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 22),
      decoration: BoxDecoration(color: C.limeBg, borderRadius: BorderRadius.circular(18), border: Border.all(color: C.limeBorder)),
      child: Column(
        children: [
          Text('🎉', style: const TextStyle(fontSize: 32)),
          const SizedBox(height: 8),
          Text('รับกล่อง ${_tag ?? ''} เข้าคลังเรียบร้อยแล้ว',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: C.limeDeep)),
        ],
      ),
    );
  }
}

/// Small filled/pulsing status dot — same widget RfidRegisterScreen defines
/// for itself; duplicated rather than shared to keep each screen's file
/// self-contained the way this codebase's other single-purpose screens are.
class _RfidDot extends StatelessWidget {
  final Color color;
  final bool pulsing;
  const _RfidDot({required this.color, required this.pulsing});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 14,
      height: 14,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        boxShadow: pulsing ? [BoxShadow(color: color.withValues(alpha: 0.35), blurRadius: 0, spreadRadius: 4)] : null,
      ),
    );
  }
}
