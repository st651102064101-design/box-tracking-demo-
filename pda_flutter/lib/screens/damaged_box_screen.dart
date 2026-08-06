import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Flags a box as damaged: scan its barcode, sweep the RFID batch on/around
/// it, save. Works fully offline by design (see AppController.addDamagedFlag)
/// — unlike box registration this menu item is never hidden when the
/// terminal has no signal, and nothing on this screen makes a network call
/// until AppController.flushDamagedFlags gets a chance to sync later.
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

  String? _barcode; // confirmed once the field auto-submits or Enter fires
  final List<String> _epcs = []; // distinct EPCs the sweep has turned up

  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<RfidStatus>? _statusSub;
  RfidStatus _rfidStatus = const RfidStatus(RfidState.idle, '');
  RfidService? _rfid;

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
    // against the box in question.
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
    if (_barcode == null || read.epc.isEmpty) return;
    if (_epcs.contains(read.epc)) return;
    setState(() => _epcs.add(read.epc));
  }

  void _save() {
    final barcode = _barcode;
    if (barcode == null) return;
    _c.addDamagedFlag(barcode: barcode, rfidEpcs: List<String>.from(_epcs), note: _noteCtrl.text.trim());
    unawaited(_c.rfid.stopInventory());
    _c.toastMsg(
      'บันทึกแล้ว',
      _c.connected ? 'กำลังส่งรายงานเข้าระบบ' : 'ออฟไลน์ — จะส่งรายงานอัตโนมัติเมื่อออนไลน์',
      ResultKind.ok,
    );
    setState(() {
      _barcode = null;
      _epcs.clear();
    });
    _barcodeCtrl.clear();
    _noteCtrl.clear();
    _lastKeyAt = null;
    _sawBurst = false;
    _barcodeFocus.requestFocus();
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
              _barcodeCard(),
              const SizedBox(height: 12),
              _rfidCard(),
              const SizedBox(height: 12),
              _noteCard(),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _barcode == null ? null : _save,
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

  Widget _rfidCard() {
    final active = _barcode != null;
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
                    active ? 'สแกน RFID batch (ไม่บังคับ)' : 'ยิงบาร์โค้ดก่อนเพื่อเริ่มสแกน RFID',
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
              else
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
                ),
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
          TextField(
            controller: _noteCtrl,
            maxLines: 2,
            decoration: pdaInput('เช่น มุมกล่องบุบ กันชื้นฉีกขาด'),
          ),
        ],
      ),
    );
  }
}
