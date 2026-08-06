import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/api_client.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

enum _Step { waitingBarcode, waitingRfid, success }

/// Dedicated fast-path for commissioning new boxes: scan the barcode, pull
/// the trigger to read a blank tag's TID/EPC, done — the screen clears
/// itself and is ready for the next box immediately. Deliberately narrower
/// than [RfidInputScreen] (which is a general-purpose live tag viewer): this
/// one screen does exactly one job, optimized for one-handed repetition.
class RfidRegisterScreen extends StatefulWidget {
  const RfidRegisterScreen({super.key});

  @override
  State<RfidRegisterScreen> createState() => _RfidRegisterScreenState();
}

class _RfidRegisterScreenState extends State<RfidRegisterScreen> {
  final _barcodeCtrl = TextEditingController();
  final _barcodeFocus = FocusNode();

  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<RfidStatus>? _statusSub;

  _Step _step = _Step.waitingBarcode;
  String? _tag; // verified box barcode for the box currently in hand
  String? _error; // shown in the barcode card when verification fails
  String? _rfidError; // shown in the RFID card when a read can't be used
  bool _verifying = false;
  bool _binding = false;
  RfidStatus _rfidStatus = const RfidStatus(RfidState.idle, '');
  Timer? _successTimer;
  AppController get _c => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    final rfid = _c.rfid;
    _rfidStatus = RfidStatus(rfid.state, '');
    _statusSub = rfid.status.listen((s) => setState(() => _rfidStatus = s));
    _tagSub = rfid.tagReads.listen(_onTagRead);
    // Reads in the same fast profile as every other screen. This screen used
    // to switch the reader into detail mode to chase a TID, and that is what
    // stopped it reading at all: the TID access-read halts inventory around
    // every call, and on this reader it came back empty regardless, so every
    // read was rejected for having no TID. Binding on the EPC needs none of it.
    if (rfid.supported && rfid.state != RfidState.connected) rfid.connect();
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _statusSub?.cancel();
    _successTimer?.cancel();
    _barcodeCtrl.dispose();
    _barcodeFocus.dispose();
    super.dispose();
  }

  String get _today {
    final n = DateTime.now();
    return '${n.year.toString().padLeft(4, '0')}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
  }

  Future<void> _submitBarcode() async {
    final code = _barcodeCtrl.text.trim();
    if (code.isEmpty || _verifying) return;
    setState(() {
      _verifying = true;
      _error = null;
    });
    try {
      final box = await _c.api.getBox(code);
      if (box == null) {
        setState(() => _error = 'ไม่พบกล่อง "$code" ในระบบ');
        return;
      }
      final resolvedTag = (box['tag'] as String?) ?? code;
      setState(() {
        _tag = resolvedTag;
        _step = _Step.waitingRfid;
        _rfidError = null;
      });
      _barcodeCtrl.clear();
    } catch (e) {
      setState(() => _error = e is ApiException ? e.message : 'ตรวจสอบบาร์โค้ดไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _verifying = false);
    }
  }

  /// On-screen fallback for devices/testers without a comfortable trigger
  /// pull mid-flow — starts a short inventory burst, same shape as the
  /// simulate button on the scan screen.
  Future<void> _tapToRead() async {
    if (_step != _Step.waitingRfid || !_c.rfid.supported) return;
    await _c.rfid.startInventory();
    await Future.delayed(const Duration(milliseconds: 600));
    await _c.rfid.stopInventory();
  }

  void _onTagRead(RfidTagRead read) {
    if (_step != _Step.waitingRfid || _binding) return;
    if (read.epc.isEmpty) return;
    _bind(read.epc);
  }

  Future<void> _bind(String epc) async {
    final tag = _tag;
    if (tag == null) return;
    setState(() {
      _binding = true;
      _rfidError = null;
    });
    unawaited(_c.rfid.stopInventory());
    try {
      await _c.api.associateRfid(tag, rfidEpc: epc, replace: true);
      final count = _c.prefs.bumpRfidRegisteredToday(_today);
      setState(() {
        _step = _Step.success;
      });
      _c.toastMsg('ผูกแท็ก RFID แล้ว', '$tag · วันนี้ $count กล่อง', ResultKind.ok);
      _successTimer?.cancel();
      _successTimer = Timer(const Duration(milliseconds: 1400), () {
        if (!mounted) return;
        setState(() {
          _step = _Step.waitingBarcode;
          _tag = null;
        });
        _barcodeFocus.requestFocus();
      });
    } catch (e) {
      setState(() => _rfidError = e is ApiException ? e.message : 'ผูกแท็กไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _binding = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final today = _c.prefs.rfidRegisteredToday(_today);

    return Column(
      children: [
        StickyHeader(onBack: c.backToHome, title: const Text('ลงทะเบียนแท็ก RFID')),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 16),
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('ผูกสำเร็จวันนี้', style: TextStyle(fontSize: 13, color: C.muted)),
                  Text('$today กล่อง',
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: C.lime)),
                ],
              ),
              const SizedBox(height: 14),
              _barcodeCard(),
              const SizedBox(height: 12),
              _rfidCard(),
              const SizedBox(height: 14),
              _banner(),
            ],
          ),
        ),
      ],
    );
  }

  Widget _barcodeCard() {
    final verified = _step != _Step.waitingBarcode;
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
              Text(verified ? 'บาร์โค้ดถูกต้อง' : 'รอสแกนบาร์โค้ดกล่อง',
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
            ],
          ),
          const SizedBox(height: 10),
          if (verified)
            Text(_tag ?? '',
                style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, fontFamily: 'monospace'))
          else
            TextField(
              controller: _barcodeCtrl,
              focusNode: _barcodeFocus,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              autocorrect: false,
              enableSuggestions: false,
              enabled: !_verifying,
              onSubmitted: (_) => _submitBarcode(),
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
              decoration: InputDecoration(
                hintText: 'ยิงบาร์โค้ด หรือพิมพ์รหัสกล่อง',
                hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 14),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
                filled: true,
                fillColor: C.neutralBg,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
                suffixIcon: _verifying
                    ? const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                      )
                    : IconButton(icon: const Icon(Icons.arrow_forward), onPressed: _submitBarcode),
              ),
            ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(fontSize: 12.5, color: C.red)),
          ],
        ],
      ),
    );
  }

  Widget _rfidCard() {
    final active = _step == _Step.waitingRfid;
    final connected = _rfidStatus.state == RfidState.connected || !_c.rfid.supported;
    Color dot = C.border2;
    String label = 'รอสแกนแท็ก RFID';
    if (active) {
      dot = _binding ? C.limeDeep : C.orange;
      label = _binding ? 'กำลังผูกแท็ก…' : 'เหนี่ยวไกยิงแท็ก RFID';
    }
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
                _RfidDot(color: dot, pulsing: active && !_binding),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                ),
                if (active && !_binding)
                  OutlinedButton(
                    onPressed: connected ? _tapToRead : null,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: C.ink,
                      side: BorderSide(color: C.border2),
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    ),
                    child: const Text('ยิง RFID', style: TextStyle(fontSize: 12.5)),
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
          ],
        ),
      ),
    );
  }

  Widget _banner() {
    late Color bg, fg, border;
    late String text;
    switch (_step) {
      case _Step.waitingBarcode:
        bg = C.neutralBg;
        fg = C.ink2;
        border = C.border2;
        text = '📢 คำแนะนำ: ยิงบาร์โค้ดที่ข้างกล่องก่อน';
        break;
      case _Step.waitingRfid:
        bg = C.orangeBg;
        fg = C.orange;
        border = C.orangeBorder;
        text = '📢 คำแนะนำ: แปะแท็กแล้วกดปุ่มยิง RFID';
        break;
      case _Step.success:
        bg = C.limeBg;
        fg = C.limeDeep;
        border = C.limeBorder;
        text = '🎉 สำเร็จ! ผูก ${_tag ?? ''} เรียบร้อยแล้ว';
        break;
    }
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 180),
      child: Container(
        key: ValueKey(_step),
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(14), border: Border.all(color: border)),
        child: Text(text, textAlign: TextAlign.center, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: fg)),
      ),
    );
  }
}

/// Small filled/pulsing status dot — plain colour when idle, a soft glow
/// ring while actively listening for a trigger pull.
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
