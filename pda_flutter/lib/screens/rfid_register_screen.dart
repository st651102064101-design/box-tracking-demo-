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

  /// Registration deliberately runs the antenna far below the operator's
  /// normal ใกล้/ปานกลาง/ไกล setting. Binding a tag to a box is a write, and
  /// the wrong tag bound to the wrong box is worse than a read that needs a
  /// second pull: at full power this reader inventories tags metres away, so
  /// "the tag I'm holding against the gun" has to be made true physically,
  /// not just hoped for.
  static const _registerPowerPercent = 30;

  /// Reads weaker than this are discarded natively. A backstop for the case
  /// the power drop alone doesn't cover — if the tag in hand isn't answering,
  /// the right outcome is nothing happening, never a distant box getting
  /// silently rebound.
  static const _registerRssiFloor = -65;

  /// How long to keep listening after the first accepted read before deciding
  /// which tag the operator meant. Long enough for a second, nearer tag to
  /// arrive, short enough to still feel instant in one-handed repetition.
  static const _pickWindow = Duration(milliseconds: 450);

  _Step _step = _Step.waitingBarcode;
  String? _tag; // verified box barcode for the box currently in hand
  String? _error; // shown in the barcode card when verification fails
  String? _rfidError; // shown in the RFID card when a read can't be used
  bool _verifying = false;
  bool _binding = false;
  RfidStatus _rfidStatus = const RfidStatus(RfidState.idle, '');
  Timer? _successTimer;

  /// Reads seen in the current [_pickWindow], strongest-wins. Binding the
  /// first read to arrive was the bug behind "จ่อใกล้ ๆ ไม่เจอ เจอแต่ตัวไกล ๆ":
  /// a far tag whose TID rode along with the inventory was emitted
  /// immediately, while the near tag — the one that needs a follow-up TID
  /// read — arrived a moment later and lost the race every time.
  final List<RfidTagRead> _candidates = [];
  Timer? _pickTimer;

  AppController get _c => context.read<AppController>();

  /// Captured in [initState] because [dispose] has to put the reader back the
  /// way it found it, and reaching for an InheritedWidget through `context`
  /// that late is not allowed.
  late final AppController _app;

  @override
  void initState() {
    super.initState();
    _app = context.read<AppController>();
    final rfid = _c.rfid;
    _rfidStatus = RfidStatus(rfid.state, '');
    _statusSub = rfid.status.listen((s) {
      if (mounted) setState(() => _rfidStatus = s);
      // The reader comes up at full power on every (re)connect, so the
      // registration-specific tuning has to be re-applied then, not only on
      // entering the screen.
      if (s.state == RfidState.connected) _applyRegisterTuning();
    });
    _tagSub = rfid.tagReads.listen(_onTagRead);
    if (rfid.supported && rfid.state != RfidState.connected) {
      rfid.connect();
    } else {
      _applyRegisterTuning();
    }
  }

  /// Narrow the reader down to "the tag being held against it": low power, a
  /// hard RSSI floor, and TID reads switched on (this is one of the few
  /// screens that genuinely needs a TID, and the only reason to pay the
  /// inventory stall the TID access read costs).
  void _applyRegisterTuning() {
    final rfid = _app.rfid;
    rfid.setPowerPercent(_registerPowerPercent);
    rfid.setRssiThreshold(_registerRssiFloor);
    rfid.setTidLookup(true);
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _statusSub?.cancel();
    _successTimer?.cancel();
    _pickTimer?.cancel();
    // Hand the reader back exactly as the rest of the app expects it —
    // operator's own power setting, no floor, and TID reads off so the scan
    // and track screens stream continuously again.
    final rfid = _app.rfid;
    rfid.setTidLookup(false);
    rfid.setRssiThreshold(null);
    rfid.setPowerPercent(_app.prefs.rfidPowerPercent);
    unawaited(rfid.stopInventory());
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
      // Anything picked up before this box was identified belongs to the
      // previous one — never let it carry over into this binding.
      _pickTimer?.cancel();
      _pickTimer = null;
      _candidates.clear();
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
    // Collect rather than bind. A single pull can surface several tags, and
    // the first one to arrive is not the one the operator is aiming at — see
    // [_candidates]. The decision happens once in [_pickWinner].
    _candidates.add(read);
    _pickTimer ??= Timer(_pickWindow, _pickWinner);
  }

  /// Picks the strongest read of the window and binds it. Reads with no TID
  /// are not usable for binding, but their presence still means a tag *was*
  /// there — worth a different message than silence.
  void _pickWinner() {
    _pickTimer = null;
    if (!mounted || _step != _Step.waitingRfid || _binding) {
      _candidates.clear();
      return;
    }
    final seen = List<RfidTagRead>.from(_candidates);
    _candidates.clear();
    if (seen.isEmpty) return;

    final usable = seen.where((r) => r.tid != null).toList();
    if (usable.isEmpty) {
      setState(() => _rfidError =
          'อ่าน TID จากแท็กไม่ได้ — ลองยิงใหม่อีกครั้ง (ต้องเป็นแท็กที่รองรับการอ่าน TID)');
      return;
    }
    // Strongest signal wins = physically nearest. A read with no RSSI at all
    // sorts last: it can still be bound if it's the only candidate, but it
    // should never beat a tag we have a real measurement for.
    usable.sort((a, b) => (b.rssi ?? -999).compareTo(a.rssi ?? -999));
    final winner = usable.first;
    _bind(winner.tid!, winner.epc);
  }

  Future<void> _bind(String tid, String epc) async {
    final tag = _tag;
    if (tag == null) return;
    setState(() {
      _binding = true;
      _rfidError = null;
    });
    unawaited(_c.rfid.stopInventory());
    try {
      await _c.api.associateRfid(tag, rfidTid: tid, rfidEpc: epc, replace: true);
      final count = _c.prefs.bumpRfidRegisteredToday(_today);
      setState(() {
        _step = _Step.success;
      });
      _c.toastMsg('ผูกแท็ก RFID แล้ว', '$tag · วันนี้ $count กล่อง', ResultKind.ok);
      _successTimer?.cancel();
      _successTimer = Timer(const Duration(milliseconds: 1400), () {
        if (!mounted) return;
        _pickTimer?.cancel();
        _pickTimer = null;
        _candidates.clear();
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
