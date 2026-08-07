import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/api_client.dart';
import '../services/rfid_service.dart';
import '../services/scan_speed_detector.dart';
import '../theme.dart';
import '../widgets/common.dart';

enum _Step { waitingBarcode, waitingRfid, success }

/// One distinct tag the sweep turned up, with the best signal it showed and how
/// many times it answered — the two things that tell "the tag in my hand" apart
/// from "a tag on the next shelf" when several come back at once.
///
/// [claimedByTag] starts null (not checked yet) and is filled in once the
/// server answers whether this EPC already belongs to some other box — see
/// _checkClaimed. A tag showing up here already tagged is not rare: sweeping
/// near a box that was tagged earlier reads its neighbour's tag right along
/// with the blank one actually in hand.
class _Candidate {
  final String epc;
  final int? rssi;
  final int hits;
  final String? claimedByTag;

  /// Whether the "is this tag already bound?" lookup has come back yet.
  /// Without this, `claimedByTag == null` means both "free" and "we haven't
  /// asked yet" — and the screen showed the optimistic one, so a tag that was
  /// about to turn out to belong to another box read as bindable for as long
  /// as the round trip took. The operator has to be able to tell "ยังไม่เคยผูก"
  /// from "กำลังตรวจสอบ" before deciding.
  final bool checked;

  const _Candidate({
    required this.epc,
    this.rssi,
    required this.hits,
    this.claimedByTag,
    this.checked = false,
  });

  bool get isFree => checked && claimedByTag == null;
}

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
  StreamSubscription<bool>? _triggerSub;

  /// True only while a sweep the operator asked for is running. The reader is
  /// never armed on this screen without a trigger pull or a tap.
  bool _sweeping = false;

  /// Auto-submits the barcode field without a trailing Enter/Tab keystroke,
  /// from keystroke timing rather than a flat "quiet for Nms" debounce — a
  /// flat debounce fired mid-entry on any human who paused typing longer
  /// than its own delay (a very ordinary pause), cutting the code off short.
  /// See ScanSpeedAutoSubmit's own doc for why this has to observe an actual
  /// scan-speed gap before ever arming a timer. onSubmitted (Enter) still
  /// fires immediately when the terminal *is* configured with a suffix key;
  /// this is only the fallback for when it isn't.
  late final _barcodeAutoSubmit = ScanSpeedAutoSubmit(onAutoSubmit: () {
    if (!mounted || _verifying) return;
    _submitBarcode();
  }, minLen: 4);

  _Step _step = _Step.waitingBarcode;
  String? _tag; // verified box barcode for the box currently in hand
  String? _error; // shown in the barcode card when verification fails
  String? _rfidError; // shown in the RFID card when a read can't be used
  bool _verifying = false;
  bool _binding = false;
  /// Distinct tags this sweep has turned up, strongest signal first.
  final List<_Candidate> _found = [];
  /// The one the operator ticked. Never set by the app — an auto-selection is
  /// indistinguishable on screen from a deliberate one, and this is the step
  /// that decides which physical box a tag belongs to from here on.
  String? _selectedEpc;
  RfidStatus _rfidStatus = const RfidStatus(RfidState.idle, '');
  Timer? _successTimer;
  // Held so dispose() can stop the reader without reading it off a context
  // that is already unmounting.
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
    _triggerSub = rfid.triggers.listen((pressed) {
      if (mounted) setState(() => _sweeping = pressed);
    });
    // Reads in the same fast profile as every other screen. This screen used
    // to switch the reader into detail mode to chase a TID, and that is what
    // stopped it reading at all: the TID access-read halts inventory around
    // every call, and on this reader it came back empty regardless, so every
    // read was rejected for having no TID. Binding on the EPC needs none of it.
    if (rfid.supported && rfid.state != RfidState.connected) rfid.connect();
    _barcodeCtrl.addListener(_onBarcodeChanged);
  }

  @override
  void dispose() {
    // The reader is armed on this screen without anyone pressing anything, so
    // it has to be disarmed the same way — a stray back-navigation must not
    // leave it sweeping in the background.
    _rfid?.stopInventory();
    _tagSub?.cancel();
    _statusSub?.cancel();
    _triggerSub?.cancel();
    _successTimer?.cancel();
    _barcodeAutoSubmit.dispose();
    _barcodeCtrl.removeListener(_onBarcodeChanged);
    _barcodeCtrl.dispose();
    _barcodeFocus.dispose();
    super.dispose();
  }

  void _onBarcodeChanged() {
    if (_verifying) return;
    _barcodeAutoSubmit.onChanged(_barcodeCtrl.text.trim());
  }

  String get _today {
    final n = DateTime.now();
    return '${n.year.toString().padLeft(4, '0')}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
  }

  /// Undoes a mis-scanned barcode without leaving the screen. Stops the
  /// reader (it was armed the moment the barcode landed, see
  /// [_submitBarcode]) and drops the RFID sweep so far — those reads were
  /// against the wrong box and would otherwise sit in [_found] ready to bind
  /// onto whatever gets scanned next.
  void _changeBarcode() {
    unawaited(_c.rfid.stopInventory());
    setState(() {
      _step = _Step.waitingBarcode;
      _tag = null;
      _error = null;
      _rfidError = null;
      _found.clear();
      _selectedEpc = null;
    });
    _barcodeCtrl.clear();
    WidgetsBinding.instance.addPostFrameCallback((_) => _barcodeFocus.requestFocus());
  }

  Future<void> _submitBarcode() async {
    final code = _barcodeCtrl.text.trim();
    if (code.isEmpty || _verifying) return;
    _barcodeAutoSubmit.reset();
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
        // A fresh box gets a fresh list — carrying the previous box's reads
        // over is how the wrong tag gets bound.
        _found.clear();
        _selectedEpc = null;
      });
      _barcodeCtrl.clear();
      // The reader is deliberately NOT armed here. Binding rewrites which
      // physical box a tag means, and a sweep that starts on its own — while
      // the operator is still turning the box around to find a clear face —
      // fills the candidate list with whatever else is on the shelf. The
      // operator pulls the trigger when the gun is actually aimed.
    } catch (e) {
      setState(() => _error = e is ApiException ? e.message : 'ตรวจสอบบาร์โค้ดไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _verifying = false);
    }
  }

  /// Collects what the sweep finds. It does **not** bind: a trigger pull in a
  /// rack picks up every tag in range, and binding the first read would attach
  /// whichever box happened to answer first — including a neighbouring box that
  /// was already commissioned. The operator picks the right one; the screen's
  /// job is only to show the choice honestly.
  void _onTagRead(RfidTagRead read) {
    if (_step != _Step.waitingRfid || _binding) return;
    if (read.epc.isEmpty) return;
    var isNew = false;
    setState(() {
      final existing = _found.indexWhere((c) => c.epc == read.epc);
      if (existing >= 0) {
        // Same tag seen again — keep the best signal it ever showed and count
        // the hits, both of which help tell the tag in hand apart from one on
        // the next shelf. Updated in place: a tag answering 170 times a second
        // is "most recent" on every one of them, and re-sorting on that would
        // make the list churn under the operator's thumb mid-tap.
        final c = _found[existing];
        _found[existing] = _Candidate(
          epc: c.epc,
          rssi: (read.rssi ?? -999) > (c.rssi ?? -999) ? read.rssi : c.rssi,
          hits: c.hits + 1,
          claimedByTag: c.claimedByTag, // carried forward — see _checkClaimed
          checked: c.checked,
        );
      } else {
        // Newly discovered tags go on top, so the tag just brought into range
        // is the one the operator sees first. Order is by discovery, never
        // re-sorted afterwards — and nothing is preselected either way.
        _found.insert(0, _Candidate(epc: read.epc, rssi: read.rssi, hits: 1));
        isNew = true;
      }
      _rfidError = null;
    });
    // Only checked once per EPC — a repeat read of the same tag (the common
    // case, at reader speed) has no reason to ask the server the same
    // question again.
    if (isNew) _checkClaimed(read.epc);
  }

  /// Asks whether [epc] is already bound to some other box, and marks the
  /// matching candidate if so. Best-effort: a failed lookup just leaves the
  /// candidate looking free, same as before this existed — [_bindSelected]
  /// still has the server's own rejection as a backstop either way.
  Future<void> _checkClaimed(String epc) async {
    Map<String, dynamic>? box;
    try {
      box = await _c.api.getBox(epc);
    } catch (_) {
      // Offline or the lookup failed: leave it unchecked rather than claiming
      // it's free. The row stays "กำลังตรวจสอบ…" and _bindSelected's server-side
      // rejection is still the backstop.
      return;
    }
    if (!mounted) return;
    final owner = box?['tag'] as String?;
    final i = _found.indexWhere((c) => c.epc == epc);
    if (i < 0) return; // rescanned away in the meantime
    setState(() {
      final c = _found[i];
      // Recorded either way now — a confirmed-free tag is what the operator
      // is looking for, and it has to be visibly distinct from one whose
      // lookup simply hasn't landed yet.
      _found[i] = _Candidate(
        epc: c.epc,
        rssi: c.rssi,
        hits: c.hits,
        claimedByTag: owner,
        checked: true,
      );
      // Can't stay ticked if it just turned out to belong to another box —
      // the button would otherwise read "ผูกกับ …" over a selection that
      // is no longer legal to submit.
      if (owner != null && _selectedEpc == epc) _selectedEpc = null;
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
          _found.clear();
          _selectedEpc = null;
        });
        _barcodeFocus.requestFocus();
      });
    } catch (e) {
      setState(() => _rfidError = e is ApiException ? e.message : 'ผูกแท็กไม่สำเร็จ');
    } finally {
      if (mounted) setState(() => _binding = false);
    }
  }

  Future<void> _rescan() async {
    setState(() {
      _found.clear();
      _selectedEpc = null;
      _rfidError = null;
    });
    await _toggleSweep(force: true);
  }

  /// Starts/stops a sweep on demand — the on-screen twin of the trigger.
  Future<void> _toggleSweep({bool force = false}) async {
    final c = _c;
    if (!c.rfid.supported) return;
    if (_sweeping && !force) {
      setState(() => _sweeping = false);
      await c.rfid.stopInventory();
      return;
    }
    if (c.rfidCharging) {
      c.toastMsg('ยิงแท็กไม่ได้ขณะชาร์จ', 'ยกเครื่องออกจากแท่นชาร์จก่อน', ResultKind.warn);
      return;
    }
    setState(() => _sweeping = true);
    await c.rfid.startInventory();
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
                  color: verified ? C.limeText : C.red, size: 18),
              const SizedBox(width: 8),
              Text(verified ? 'บาร์โค้ดถูกต้อง' : 'รอสแกนบาร์โค้ดกล่อง',
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
            ],
          ),
          const SizedBox(height: 10),
          if (verified)
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Text(_tag ?? '',
                      style: const TextStyle(
                          fontSize: 26, fontWeight: FontWeight.w800, fontFamily: 'monospace')),
                ),
                // Only while still waiting on the RFID read — once a tag is
                // actually being bound or the success banner is showing,
                // changing the barcode out from under it would be confusing,
                // not helpful. Exists because scanning the wrong box's
                // barcode used to mean backing all the way out of this
                // screen and back in just to fix a mis-scan.
                if (_step == _Step.waitingRfid)
                  TextButton(
                    onPressed: _changeBarcode,
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: Text('เปลี่ยนบาร์โค้ด',
                        style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.orange)),
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
                    : SubmitArrowButton(onTap: _submitBarcode),
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
      dot = _binding ? C.limeText : C.orange;
      // "กำลังอ่านแท็ก" used to show the moment a barcode landed, while the
      // reader was in fact idle — the screen claimed to be reading when
      // nothing had been triggered yet. It now reflects the actual sweep.
      label = _binding
          ? 'กำลังผูกแท็ก…'
          : _sweeping
              ? 'กำลังอ่านแท็ก…'
              : 'พร้อมอ่าน — เหนี่ยวไกเพื่อเริ่ม';
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
            if (active && !_binding) ...[
              const SizedBox(height: 12),
              // Explicit twin of the trigger. Present from the moment the
              // barcode lands, because that is exactly when the reader is
              // *not* running any more and the operator needs a way to start.
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _c.rfid.supported ? () => _toggleSweep() : null,
                  icon: Icon(_sweeping ? Icons.stop : Icons.wifi_tethering, size: 18),
                  label: Text(_sweeping ? 'กำลังยิง… แตะเพื่อหยุด' : 'ยิงแท็ก (หรือเหนี่ยวไก)',
                      style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: _sweeping ? C.red : C.ink,
                    backgroundColor: _sweeping ? C.orangeBg : null,
                    side: BorderSide(color: _sweeping ? C.orangeBorder : C.border2),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              if (_found.isEmpty)
                Text('ยังไม่พบแท็ก — เหนี่ยวไกหรือแตะปุ่มด้านบน โดยจ่อไปที่แท็กของกล่องนี้',
                    style: TextStyle(fontSize: 12.5, color: C.faint))
              else ...[
                Row(
                  children: [
                    Expanded(
                      child: Text(_foundSummary(),
                          style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
                    ),
                    GestureDetector(
                      onTap: _rescan,
                      child: Text('ยิงใหม่', style: TextStyle(fontSize: 12.5, color: C.orange)),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                // A plain list, not a scroll view: a sweep that turns up so many
                // tags that this needs scrolling is a sweep that was pointed at
                // a rack rather than a box, and "ยิงใหม่" from closer in is the
                // right answer to that, not more scrolling.
                // RadioGroup owns the selection for the whole list; Radio's own
                // groupValue/onChanged are deprecated in this Flutter version.
                RadioGroup<String>(
                  groupValue: _selectedEpc,
                  onChanged: (v) => setState(() => _selectedEpc = v),
                  child: Column(children: _found.map(_candidateRow).toList()),
                ),
                const SizedBox(height: 10),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    // Stays disabled until something is ticked. Binding is the
                    // irreversible half of this screen — it rewrites which
                    // physical box that tag means from here on — so it takes a
                    // deliberate press, never a default.
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
      ),
    );
  }

  /// "พบ N แท็ก · ว่าง X · ผูกแล้ว Y" — the split is the whole point of a
  /// sweep in a rack: the operator needs to know at a glance how many of the
  /// tags that just answered are actually available to bind.
  String _foundSummary() {
    final free = _found.where((c) => c.isFree).length;
    final claimed = _found.where((c) => c.claimedByTag != null).length;
    final parts = <String>['พบ ${_found.length} แท็ก'];
    if (free > 0) parts.add('ยังไม่เคยผูก $free');
    if (claimed > 0) parts.add('ผูกแล้ว $claimed');
    return parts.join(' · ');
  }

  Widget _candidateRow(_Candidate c) {
    // Already bound to a different box: shown, not selectable. No Radio at
    // all here rather than a disabled one — that's what makes it genuinely
    // impossible to tick regardless of Flutter's Radio/RadioGroup version,
    // not just visually discouraged.
    if (c.claimedByTag != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            const SizedBox(width: 8),
            Icon(Icons.block, size: 17, color: C.faint),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(c.epc,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                fontSize: 13,
                                fontFamily: 'monospace',
                                fontWeight: FontWeight.w600,
                                color: C.faint)),
                      ),
                      const SizedBox(width: 7),
                      Pill('ผูกแล้ว', color: C.red, bg: C.redBg, fontSize: 10),
                    ],
                  ),
                  Text('ผูกกับกล่อง ${c.claimedByTag} อยู่แล้ว',
                      style: TextStyle(fontSize: 11.5, color: C.red, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
          ],
        ),
      );
    }

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
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          c.epc,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13,
                            fontFamily: 'monospace',
                            fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                            color: selected ? C.ink : C.ink2,
                          ),
                        ),
                      ),
                      const SizedBox(width: 7),
                      // The verdict, stated on the row itself. A blank tag is
                      // what this screen exists to bind, so "ยังไม่เคยผูก" has
                      // to be affirmative rather than merely the absence of a
                      // warning — and an unfinished lookup says so plainly
                      // instead of passing for free.
                      if (c.isFree)
                        Pill('ยังไม่เคยผูก', color: C.limeText, bg: C.limeBg, fontSize: 10)
                      else
                        Pill('กำลังตรวจสอบ…', color: C.muted, bg: C.neutralBg, fontSize: 10),
                    ],
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
        text = '📢 เหนี่ยวไกเพื่ออ่านแท็ก แล้วเลือกใบที่ "ยังไม่เคยผูก"';
        break;
      case _Step.success:
        bg = C.limeBg;
        fg = C.limeText;
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
