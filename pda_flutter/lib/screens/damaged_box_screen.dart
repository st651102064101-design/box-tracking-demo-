import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

enum _IdMode { barcode, rfid }

/// Quick-tap guides for the free-text damage note — there's no backend enum
/// of damage reasons to source these from yet (POST /api/boxes/:tag/damage
/// itself doesn't exist server-side yet, see ApiClient.flagDamage), so this
/// is a reasonable starting set an operator can tap instead of typing every
/// time, not a fixed status. Swap this for a real config-driven list (and
/// send a reason code instead of free text) once that endpoint exists.
const _kDamageReasons = ['กล่องบุบ', 'กล่องแตก/ฉีกขาด', 'เปียกน้ำ', 'ฝา/ล็อกชำรุด', 'สติกเกอร์ฉีกขาด', 'แท็ก RFID หลุด/เสียหาย'];

/// Flags a box as damaged: pick barcode or RFID as how this box gets
/// identified, then save. Works fully offline by design (see
/// AppController.addDamagedFlag) — unlike box registration this menu item is
/// never hidden when the terminal has no signal, and nothing on this screen
/// makes a network call until AppController.flushDamagedFlags gets a chance
/// to sync later.
class DamagedBoxScreen extends StatefulWidget {
  const DamagedBoxScreen({super.key});
  @override
  State<DamagedBoxScreen> createState() => _DamagedBoxScreenState();
}

class _DamagedBoxScreenState extends State<DamagedBoxScreen> {
  final _barcodeCtrl = TextEditingController();
  final _barcodeFocus = FocusNode();
  final _noteCtrl = TextEditingController();

  // Same burst-vs-typed detection box_register_screen.dart uses for its own
  // barcode field — a scanner gun's whole payload lands within a few ms of
  // itself, a person thumbing this in on the handheld's keypad never does.
  Timer? _autoSubmitTimer;
  static const _autoSubmitDelay = Duration(milliseconds: 180);
  static const _autoSubmitMinLen = 2;
  static const _burstMaxGap = Duration(milliseconds: 40);
  DateTime? _lastKeyAt;
  bool _sawBurst = false;

  // A damaged box's barcode sticker is itself sometimes the thing that's
  // torn or unreadable — forcing barcode-first (the old design) meant that
  // exact box could never be reported at all. The operator picks whichever
  // identifier is actually still legible; the other stays available as an
  // optional add-on (a barcode scan still arms the RFID sweep, and an RFID
  // pick can still have a barcode typed in afterwards).
  _IdMode _mode = _IdMode.barcode;
  String? _barcode; // confirmed once the field auto-submits or Enter fires
  String? _selectedEpc; // the tag picked as this box's identifier, RFID mode
  final List<String> _epcs = []; // distinct EPCs the sweep has turned up

  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<RfidStatus>? _statusSub;
  RfidStatus _rfidStatus = const RfidStatus(RfidState.idle, '');
  RfidService? _rfid;

  AppController get _c => context.read<AppController>();

  bool get _identified => _mode == _IdMode.barcode ? _barcode != null : _selectedEpc != null;

  @override
  void initState() {
    super.initState();
    final rfid = _c.rfid;
    _rfid = rfid;
    _rfidStatus = RfidStatus(rfid.state, '');
    _statusSub = rfid.status.listen((s) => setState(() => _rfidStatus = s));
    _tagSub = rfid.tagReads.listen(_onTagRead);
    if (rfid.supported && rfid.state != RfidState.connected) rfid.connect();
    _barcodeCtrl.addListener(_onBarcodeChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _barcodeFocus.requestFocus());
  }

  @override
  void dispose() {
    _rfid?.stopInventory();
    _tagSub?.cancel();
    _statusSub?.cancel();
    _autoSubmitTimer?.cancel();
    _barcodeCtrl.removeListener(_onBarcodeChanged);
    _barcodeCtrl.dispose();
    _barcodeFocus.dispose();
    _noteCtrl.dispose();
    super.dispose();
  }

  void _setMode(_IdMode m) {
    if (_mode == m) return;
    unawaited(_c.rfid.stopInventory());
    setState(() {
      _mode = m;
      _barcode = null;
      _selectedEpc = null;
      _epcs.clear();
    });
    _barcodeCtrl.clear();
    _lastKeyAt = null;
    _sawBurst = false;
    if (m == _IdMode.barcode) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _barcodeFocus.requestFocus());
    } else {
      // RFID mode needs no prior scan to arm — that was exactly the old,
      // wrong sequencing. Sweep starts the moment this mode is picked.
      unawaited(_c.rfid.startInventory());
    }
  }

  void _onBarcodeChanged() {
    _autoSubmitTimer?.cancel();
    final now = DateTime.now();
    final prev = _lastKeyAt;
    _lastKeyAt = now;
    if (prev != null && now.difference(prev) <= _burstMaxGap) _sawBurst = true;
    final text = _barcodeCtrl.text.trim();
    if (!_sawBurst || text.length < _autoSubmitMinLen) return;
    _autoSubmitTimer = Timer(_autoSubmitDelay, () {
      if (!mounted || _barcodeCtrl.text.trim() != text) return;
      _confirmBarcode();
    });
  }

  void _confirmBarcode() {
    final code = _barcodeCtrl.text.trim();
    if (code.isEmpty) return;
    _autoSubmitTimer?.cancel();
    setState(() => _barcode = code);
    // Arm the reader the instant the barcode lands, same reasoning as
    // rfid_register_screen.dart — the operator is already holding the gun
    // against the box in question. Still optional in this mode: saving
    // works with zero EPCs swept.
    unawaited(_c.rfid.startInventory());
  }

  void _changeBarcode() {
    unawaited(_c.rfid.stopInventory());
    setState(() {
      _barcode = null;
      _epcs.clear();
    });
    _barcodeCtrl.clear();
    _lastKeyAt = null;
    _sawBurst = false;
    WidgetsBinding.instance.addPostFrameCallback((_) => _barcodeFocus.requestFocus());
  }

  void _onTagRead(RfidTagRead read) {
    if (read.epc.isEmpty) return;
    if (_mode == _IdMode.barcode && _barcode == null) return; // not armed yet
    if (_epcs.contains(read.epc)) return;
    setState(() => _epcs.add(read.epc));
  }

  void _rescan() {
    setState(() {
      _epcs.clear();
      _selectedEpc = null;
    });
    unawaited(_c.rfid.startInventory());
  }

  void _appendReason(String reason) {
    final cur = _noteCtrl.text.trim();
    _noteCtrl.text = cur.isEmpty ? reason : '$cur, $reason';
    _noteCtrl.selection = TextSelection.collapsed(offset: _noteCtrl.text.length);
  }

  void _save() {
    if (!_identified) return;
    // In RFID mode there's no separate barcode scan — the picked EPC is
    // itself this record's identifier, alongside the rest of the swept
    // batch (including that same EPC, so "which tag actually IDs the box"
    // isn't lost once it's just one entry among several).
    final barcode = _mode == _IdMode.barcode ? _barcode! : _selectedEpc!;
    _c.addDamagedFlag(barcode: barcode, rfidEpcs: List<String>.from(_epcs), note: _noteCtrl.text.trim());
    unawaited(_c.rfid.stopInventory());
    _c.toastMsg(
      'บันทึกแล้ว',
      _c.connected ? 'กำลังส่งรายงานเข้าระบบ' : 'ออฟไลน์ — จะส่งรายงานอัตโนมัติเมื่อออนไลน์',
      ResultKind.ok,
    );
    setState(() {
      _barcode = null;
      _selectedEpc = null;
      _epcs.clear();
    });
    _barcodeCtrl.clear();
    _noteCtrl.clear();
    _lastKeyAt = null;
    _sawBurst = false;
    if (_mode == _IdMode.barcode) _barcodeFocus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final pendingSync = c.damagedFlags.where((f) => !f.synced).length;

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: const Text('แจ้งกล่องเสียหาย'),
          subtitle: !c.connected
              ? const Text('ออฟไลน์ — บันทึกในเครื่องนี้ก่อน จะซิงค์เมื่อออนไลน์')
              : null,
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 16),
            children: [
              if (pendingSync > 0)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    decoration: BoxDecoration(
                      color: C.orangeBg,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: C.orangeBorder),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.cloud_upload_outlined, size: 16, color: C.orange),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text('รอซิงค์ $pendingSync รายการ',
                              style: TextStyle(fontSize: 12.5, color: C.orange, fontWeight: FontWeight.w700)),
                        ),
                        if (c.connected)
                          GestureDetector(
                            onTap: c.flushDamagedFlags,
                            child: Text('ลองอีกครั้ง',
                                style: TextStyle(fontSize: 12.5, color: C.orange, fontWeight: FontWeight.w700)),
                          ),
                      ],
                    ),
                  ),
                ),
              const FieldLabel('วิธีระบุกล่อง'),
              _modeToggle(),
              const SizedBox(height: 12),
              if (_mode == _IdMode.barcode) ...[
                _barcodeCard(),
                const SizedBox(height: 12),
                _rfidCard(optional: true),
              ] else
                _rfidCard(optional: false),
              const SizedBox(height: 12),
              _noteCard(),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _identified ? _save : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: C.red,
                    foregroundColor: Colors.white,
                    disabledBackgroundColor: C.neutralBg,
                    disabledForegroundColor: C.faint,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
                  ),
                  child: const Text('บันทึกรายงานความเสียหาย',
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _modeToggle() {
    Widget seg(_IdMode m, String label, IconData icon) {
      final selected = _mode == m;
      return Expanded(
        child: GestureDetector(
          onTap: () => _setMode(m),
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
                        fontSize: 12.5, fontWeight: FontWeight.w700, color: selected ? C.surface : C.ink2)),
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
          seg(_IdMode.barcode, 'บาร์โค้ด', Icons.qr_code_scanner),
          seg(_IdMode.rfid, 'RFID', Icons.nfc),
        ],
      ),
    );
  }

  Widget _barcodeCard() {
    final verified = _barcode != null;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: verified ? C.limeBorder : C.border2, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(verified ? Icons.check_circle : Icons.circle_outlined,
                  color: verified ? C.limeDeep : C.red, size: 18),
              const SizedBox(width: 8),
              Text(verified ? 'บาร์โค้ดกล่อง' : 'ยิงบาร์โค้ดกล่องที่เสียหาย',
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
            ],
          ),
          const SizedBox(height: 10),
          if (verified)
            Row(
              children: [
                Expanded(
                  child: Text(_barcode!,
                      style: const TextStyle(
                          fontSize: 24, fontWeight: FontWeight.w800, fontFamily: 'monospace')),
                ),
                TextButton(
                  onPressed: _changeBarcode,
                  style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap),
                  child: Text('เปลี่ยน', style: TextStyle(fontSize: 12.5, color: C.orange, fontWeight: FontWeight.w700)),
                ),
              ],
            )
          else
            TextField(
              controller: _barcodeCtrl,
              focusNode: _barcodeFocus,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              autocorrect: false,
              enableSuggestions: false,
              onSubmitted: (_) => _confirmBarcode(),
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
              decoration: InputDecoration(
                hintText: 'ยิงบาร์โค้ด หรือพิมพ์รหัสกล่อง',
                hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 14),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
                filled: true,
                fillColor: C.neutralBg,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
                suffixIcon: IconButton(icon: const Icon(Icons.arrow_forward), onPressed: _confirmBarcode),
              ),
            ),
        ],
      ),
    );
  }

  /// [optional] is true only in barcode mode, where this card is an
  /// additive batch sweep on top of an already-identified box. In RFID
  /// mode this card *is* the identification step — picking a candidate is
  /// what makes [_identified] true.
  Widget _rfidCard({required bool optional}) {
    final active = optional ? _barcode != null : true;
    final connected = _rfidStatus.state == RfidState.connected || !_c.rfid.supported;
    return Opacity(
      opacity: active ? 1 : 0.55,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: C.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: active ? C.orangeBorder : C.border2, width: 1.5),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.nfc, size: 18, color: active ? C.orange : C.faint),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    !active
                        ? 'ยิงบาร์โค้ดก่อนเพื่อสแกน RFID เพิ่ม (ไม่บังคับ)'
                        : optional
                            ? 'สแกน RFID batch เพิ่ม (ไม่บังคับ)'
                            : 'ยิงแท็ก RFID แล้วเลือกใบที่จะใช้ระบุกล่อง',
                    style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
                  ),
                ),
                if (active)
                  Text('${_epcs.length} แท็ก',
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
              ],
            ),
            if (active && !connected)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                    'เครื่องอ่าน RFID ยังไม่พร้อม — ${_rfidStatus.message.isEmpty ? "กำลังเชื่อมต่อ…" : _rfidStatus.message}',
                    style: TextStyle(fontSize: 12, color: C.orange)),
              ),
            if (active) ...[
              const SizedBox(height: 10),
              if (_epcs.isEmpty)
                Text('เหนี่ยวไกเพื่อกวาดหาแท็กที่ติดอยู่กับกล่อง/พาเลทนี้',
                    style: TextStyle(fontSize: 12.5, color: C.faint))
              else if (optional)
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: _epcs
                      .map((e) => Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration:
                                BoxDecoration(color: C.neutralBg, borderRadius: BorderRadius.circular(8)),
                            child: Text(e,
                                style: TextStyle(
                                    fontSize: 11, fontFamily: 'monospace', color: C.ink2)),
                          ))
                      .toList(),
                )
              else ...[
                Row(
                  children: [
                    Expanded(
                      child: Text('พบ ${_epcs.length} แท็ก — เลือกใบที่จะใช้ระบุกล่อง',
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
                  child: Column(
                    children: _epcs
                        .map((epc) => InkWell(
                              onTap: () => setState(() => _selectedEpc = epc),
                              borderRadius: BorderRadius.circular(12),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(vertical: 4),
                                child: Row(
                                  children: [
                                    Radio<String>(
                                      value: epc,
                                      visualDensity: VisualDensity.compact,
                                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                    ),
                                    const SizedBox(width: 6),
                                    Expanded(
                                      child: Text(epc,
                                          style: TextStyle(
                                              fontSize: 13,
                                              fontFamily: 'monospace',
                                              fontWeight: _selectedEpc == epc ? FontWeight.w800 : FontWeight.w600,
                                              color: _selectedEpc == epc ? C.ink : C.ink2)),
                                    ),
                                  ],
                                ),
                              ),
                            ))
                        .toList(),
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  Widget _noteCard() {
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
          const FieldLabel('รายละเอียดความเสียหาย (ไม่บังคับ)'),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: _kDamageReasons
                .map((r) => GestureDetector(
                      onTap: () => _appendReason(r),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: C.neutralBg,
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: C.border2),
                        ),
                        child: Text(r, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: C.ink2)),
                      ),
                    ))
                .toList(),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _noteCtrl,
            maxLines: 2,
            decoration: pdaInput('แตะข้อความด้านบน หรือพิมพ์เอง'),
          ),
        ],
      ),
    );
  }
}
