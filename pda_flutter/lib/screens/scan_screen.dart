import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/i18n.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});
  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

const _vehicleTypes = [
  'รถกระบะ',
  'รถบรรทุก 6 ล้อ',
  'รถบรรทุก 10 ล้อ',
  'รถเทรลเลอร์',
  'อื่นๆ'
];

class _ScanScreenState extends State<ScanScreen> {
  final _scanCtrl = TextEditingController();
  final _plateCtrl = TextEditingController();
  final _driverCtrl = TextEditingController();
  final _outVtypeOtherCtrl = TextEditingController();
  final _inPlateCtrl = TextEditingController();
  final _inDriverCtrl = TextEditingController();
  final _inVtypeOtherCtrl = TextEditingController();
  final _scanFocus = FocusNode();

  /// Details-then-scan, same shape on both directions: the customer/vehicle
  /// form comes first (nothing about it depends on which boxes end up
  /// scanned), "ถัดไป" moves to the scanner/queue step, and the actual
  /// commit only happens from there. Reset is implicit — setMode() always
  /// routes through a fresh ScanScreen instance (see root_screen.dart's
  /// ValueKey), so this never needs to be cleared by hand between Gate In
  /// and Gate Out.
  bool _onScanStep = false;

  /// True while the reader's trigger is actually held down. In RFID mode
  /// this collapses the toggle/status card down to a slim "กำลังอ่าน…"
  /// strip — the operator pulled the trigger to watch boxes land in the
  /// queue, not to keep looking at a card that already told them RFID mode
  /// is selected.
  bool _rfidReading = false;
  StreamSubscription<bool>? _triggerSub;

  /// Debounce auto-submit for the scan field, same reasoning as
  /// RfidRegisterScreen's barcode field: this terminal doesn't reliably send
  /// a trailing Enter after a scan, so waiting for the field to go quiet is
  /// the fallback that makes dropping the "+" button here safe. onSubmitted
  /// (Enter) still fires immediately when a suffix key *is* configured.
  Timer? _autoSubmitTimer;
  static const _autoSubmitDelay = Duration(milliseconds: 180);
  static const _autoSubmitMinLen = 4;

  // ── putaway step (after a Gate In commit in auto/manual mode) ───────────
  /// The shelf whose barcode has actually been scanned and accepted. Null
  /// until then — which is exactly what keeps "ยืนยันเก็บเข้าชั้น" disabled,
  /// so nothing can be recorded as shelved without a scan at the shelf.
  Map<String, String>? _putawayConfirmed;

  @override
  void initState() {
    super.initState();
    _scanCtrl.addListener(_onScanChanged);
    _triggerSub = context.read<AppController>().rfid.triggers.listen((pressed) {
      if (mounted) setState(() => _rfidReading = pressed);
    });
  }

  @override
  void dispose() {
    _autoSubmitTimer?.cancel();
    _triggerSub?.cancel();
    _scanCtrl.removeListener(_onScanChanged);
    _scanCtrl.dispose();
    _plateCtrl.dispose();
    _driverCtrl.dispose();
    _outVtypeOtherCtrl.dispose();
    _inPlateCtrl.dispose();
    _inDriverCtrl.dispose();
    _inVtypeOtherCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  void _onScanChanged() {
    _autoSubmitTimer?.cancel();
    final text = _scanCtrl.text.trim();
    if (text.length < _autoSubmitMinLen) return;
    _autoSubmitTimer = Timer(_autoSubmitDelay, () {
      if (!mounted || _scanCtrl.text.trim() != text) return;
      _submit(context.read<AppController>());
    });
  }

  void _submit(AppController c) {
    _autoSubmitTimer?.cancel();
    final v = _scanCtrl.text.trim();
    if (v.isEmpty) return;
    c.addScan(v);
    _scanCtrl.clear();
    _scanFocus.requestFocus();
  }

  /// First tap (label "ถัดไป", only enabled once the form itself is valid)
  /// moves from the customer/vehicle step to the scanner/queue step; the
  /// second tap (label "ยืนยันรับเข้าคลัง"/"ยืนยันส่งออก") actually commits. A
  /// failed commit leaves the queue non-empty, which is the signal to stay
  /// on the scan step for a retry rather than snapping back to an empty
  /// form.
  Future<void> _onPrimary(AppController c, bool formValid) async {
    if (!_onScanStep) {
      if (!formValid) return;
      setState(() => _onScanStep = true);
      return;
    }
    await c.doCommit();
    if (!mounted) return;
    if (c.queue.isEmpty) setState(() => _onScanStep = false);
    // A putaway task means the commit landed and these boxes now have to be
    // physically walked to a shelf — see the putaway step in build().
    if (c.putawayTask != null) setState(() => _putawayConfirmed = null);
  }

  Future<void> _completePutaway(AppController c) async {
    final loc = context.read<LocaleController>();
    final target = _putawayConfirmed;
    if (target == null) return;
    final failed = await c.completePutaway(target);
    if (!mounted) return;
    if (failed.isEmpty) {
      c.rfid.playSound('putaway_ok');
      HapticFeedback.mediumImpact();
      setState(() => _putawayConfirmed = null);
    } else {
      c.rfid.playSound('putaway_err');
      HapticFeedback.heavyImpact();
      // Back to the scan step: whatever went wrong, the shelf is not
      // recorded, so the confirmation that implied it must not stand either.
      setState(() => _putawayConfirmed = null);
      c.toastMsg(loc.t('เก็บไม่สำเร็จ'), '${failed.length} ${loc.t('ใบ')}',
          ResultKind.err);
    }
  }

  /// The Directed Putaway errand. Two shapes over the same skeleton: a
  /// directed task names the shelf up front in the largest type on the screen
  /// (it has to be readable at arm's length from a forklift seat), an
  /// undirected one asks the operator to go find a free spot. Either way the
  /// only way forward is scanning that shelf's own barcode.
  Widget _putawayStep(AppController c, LocaleController loc, PutawayTask task) {
    final bottom = MediaQuery.of(context).padding.bottom;
    final confirmed = _putawayConfirmed;
    final target = task.assigned;
    return AutoHideHeader(
      header: StickyHeader(
        onBack: () => _confirmDropPutaway(c, loc),
        title: Row(
          children: [
            Pill(loc.t('Putaway'), color: C.limeDeep, bg: C.limeBg),
            const SizedBox(width: 7),
            Text(loc.t('นำไปเก็บเข้าชั้น')),
          ],
        ),
        subtitle: Text('${task.whName} · ${task.tags.length} ${loc.t('ใบ')}'),
      ),
      body: ListView(
        padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
        children: [
          Panel(
            padding: const EdgeInsets.all(18),
            radius: 18,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                    loc.t(target != null
                        ? 'นำสินค้าไปเก็บที่'
                        : 'หาช่องว่าง แล้วยิงบาร์โค้ดชั้นวางที่เก็บ'),
                    style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: C.muted)),
                if (target != null) ...[
                  const SizedBox(height: 10),
                  Text(locationText(target),
                      style: TextStyle(
                          fontSize: 40,
                          height: 1.05,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -1,
                          color: C.limeText)),
                ],
                const SizedBox(height: 12),
                Text(
                    '${task.tags.length} ${loc.t('ใบ')}: ${task.tags.join(', ')}',
                    style:
                        TextStyle(fontSize: 12.5, color: C.ink2, height: 1.4)),
              ],
            ),
          ),
          const SizedBox(height: 14),
          if (confirmed == null) ...[
            Text(loc.t('ยิงบาร์โค้ดชั้นวางเพื่อยืนยันว่ามาถูกช่อง'),
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: C.muted)),
            const SizedBox(height: 8),
            LocationScanField(
              controller: c,
              loc: loc,
              expected: target,
              onConfirmed: (l) => setState(() => _putawayConfirmed = l),
            ),
          ] else ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: C.limeBg,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: C.limeBorder, width: 1.5),
              ),
              child: Row(
                children: [
                  Icon(Icons.check_circle, size: 20, color: C.limeDeep),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(loc.t('ยืนยันช่องแล้ว'),
                            style: TextStyle(
                                fontSize: 12,
                                color: C.limeDeep,
                                fontWeight: FontWeight.w600)),
                        Text(locationText(confirmed),
                            style: const TextStyle(
                                fontSize: 19, fontWeight: FontWeight.w800)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: c.busy ? null : () => _completePutaway(c),
                style: FilledButton.styleFrom(
                  backgroundColor: C.ink,
                  padding: const EdgeInsets.symmetric(vertical: 15),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
                child: Text(c.busy
                    ? loc.t('กำลังบันทึก…')
                    : '${loc.t('ยืนยันเก็บเข้าชั้น')} (${task.tags.length})'),
              ),
            ),
          ],
          const SizedBox(height: 16),
          Center(
            child: GestureDetector(
              onTap: () => _confirmDropPutaway(c, loc),
              child: Text(loc.t('ยังไม่เก็บตอนนี้ — พักไว้ก่อน'),
                  style: TextStyle(
                      fontSize: 12.5,
                      color: C.muted,
                      fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }

  /// Leaving the errand is allowed but never silent: the boxes stay received
  /// with no shelf ("รอจัดเก็บ"), which someone has to pick up later, so the
  /// operator should know that is the state they are leaving behind.
  Future<void> _confirmDropPutaway(
      AppController c, LocaleController loc) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(loc.t('ยังไม่เก็บเข้าชั้น?')),
        content: Text(loc.t(
            'กล่องรับเข้าเรียบร้อยแล้ว แต่จะค้างสถานะ "รอจัดเก็บ" จนกว่าจะมีคนนำไปขึ้นชั้น')),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(loc.t('เก็บต่อ'))),
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(loc.t('พักไว้ก่อน'))),
        ],
      ),
    );
    if (ok == true) c.dropPutawayTask();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final isOut = c.mode == 'out';
    // ทะเบียนรถ is optional on both directions now. It used to be mandatory
    // on the way out, which stopped "ถัดไป" dead for the common case of a
    // plate that isn't known yet at the moment the boxes are being staged —
    // the field is still there to fill in, it just no longer blocks.
    final vtypeOk = isOut
        ? (c.outVehicleType != 'อื่นๆ' ||
            c.outVehicleTypeOther.trim().isNotEmpty)
        : (c.inVehicleType != 'อื่นๆ' ||
            c.inVehicleTypeOther.trim().isNotEmpty);
    final formValid = (!isOut || c.outCustomer.isNotEmpty) && vtypeOk;
    // Step 1 (form): "ถัดไป" needs a valid form, nothing about the queue —
    // it's still empty at this point. Step 2 (scan): commit needs both a
    // non-empty queue and the form still valid (it was checked once to get
    // here, but re-checking costs nothing and stays honest if state ever
    // changes out from under it).
    final canProceed =
        !_onScanStep ? formValid : (c.queue.isNotEmpty && formValid);

    // A pending putaway task takes over the whole screen: the receiving is
    // already done and committed, and what's left is a physical errand that
    // the form/scan steps have nothing more to say about.
    final task = c.putawayTask;
    if (task != null) return _putawayStep(c, loc, task);

    return AutoHideHeader(
      header: StickyHeader(
        onBack: c.backToHome,
        title: Row(
          children: [
            Pill(loc.t(isOut ? 'ออก' : 'เข้า'),
                color: isOut ? C.orange : C.limeDeep,
                bg: isOut ? C.orangeBg : C.limeBg),
            const SizedBox(width: 7),
            Text(loc.t(isOut ? 'ส่งออก' : 'รับเข้า / รับคืน')),
          ],
        ),
        subtitle: Text('${c.selWhName} · ${loc.t('ประตู')} ${c.gate}'),
        actions: [OnlineChip(online: c.onlineDisplay, onTap: c.onlineChipTap)],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 120),
              // Form step comes first now — nothing about ลูกค้า/ทะเบียนรถ
              // depends on which boxes end up scanned, so filling it in
              // doesn't need to wait on a scan happening first. The scan step
              // (scanner panel + queue) only shows once "ถัดไป" confirms the
              // form's valid; "แก้ไขข้อมูล…" is the way back to change it
              // without losing whatever's already been scanned.
              children: !_onScanStep
                  ? [isOut ? _outForm(c, loc) : _inForm(c, loc)]
                  : [
                      GestureDetector(
                        onTap: () => setState(() => _onScanStep = false),
                        child: Padding(
                          padding: const EdgeInsets.only(bottom: 9),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.chevron_left,
                                  size: 17, color: C.muted),
                              Text(loc.t('แก้ไขข้อมูลลูกค้า/รถ'),
                                  style: TextStyle(
                                      fontSize: 12.5,
                                      color: C.muted,
                                      fontWeight: FontWeight.w600)),
                            ],
                          ),
                        ),
                      ),
                      _scannerPanel(c, loc),
                      const SizedBox(height: 13),
                      _queueHeader(c, loc),
                      const SizedBox(height: 8),
                      ..._queueList(c, loc),
                    ],
            ),
          ),
          // Step 1 always shows "ถัดไป" (disabled until the form's valid) —
          // nothing to scan yet, so there's no queue count to gate it on. Step
          // 2 only shows the button once something's actually been scanned: a
          // disabled commit button sitting there before the first scan lands
          // invites a tap and a "why won't this work" moment.
          if (!_onScanStep || c.queue.isNotEmpty)
            Container(
              padding: EdgeInsets.fromLTRB(16, 12, 16, bottom + 14),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.bottomCenter,
                  end: Alignment.topCenter,
                  colors: [C.bg, Color(0x00F5F5F7)],
                  stops: [0.68, 1],
                ),
              ),
              child: PrimaryButton(
                label: loc.t(!_onScanStep
                    ? 'ถัดไป'
                    : (isOut ? 'ยืนยันส่งออก' : 'ยืนยันรับเข้าคลัง')),
                trailing: _onScanStep
                    ? Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 2),
                        decoration: BoxDecoration(
                            color: C.limeDeep.withOpacity(0.16),
                            borderRadius: BorderRadius.circular(999)),
                        child: Text('${c.queue.length}',
                            style: TextStyle(
                                fontSize: 14,
                                color: C.limeDeep,
                                fontFeatures: [FontFeature.tabularFigures()])),
                      )
                    : Icon(Icons.arrow_forward,
                        size: 19, color: canProceed ? C.limeDeep : C.faint),
                onTap: (canProceed && !c.busy)
                    ? () => _onPrimary(c, formValid)
                    : null,
              ),
            ),
        ],
      ),
    );
  }

  Widget _outForm(AppController c, LocaleController loc) {
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FieldLabel(loc.t('ลูกค้าปลายทาง *')),
          DropdownButtonFormField<String>(
            value: c.outCustomer.isEmpty ? null : c.outCustomer,
            isExpanded: true,
            decoration: pdaInput(loc.t('— เลือกลูกค้า —'), radius: 12),
            hint: Text(loc.t('— เลือกลูกค้า —'),
                style: TextStyle(color: C.faint)),
            items: c.customerList.map((cust) {
              final id = (cust['id'] ?? '').toString();
              return DropdownMenuItem(
                  value: id,
                  child: Text('$id · ${cust['name'] ?? ''}',
                      overflow: TextOverflow.ellipsis));
            }).toList(),
            onChanged: (v) => c.setOutCustomer(v ?? ''),
          ),
          const SizedBox(height: 11),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    FieldLabel(loc.t('ทะเบียนรถ')),
                    TextField(
                        controller: _plateCtrl,
                        onChanged: c.setOutPlate,
                        decoration: pdaInput('82-1234 กทม', radius: 12)),
                  ],
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    FieldLabel(loc.t('คนขับ')),
                    TextField(
                        controller: _driverCtrl,
                        onChanged: c.setOutDriver,
                        decoration: pdaInput(loc.t('ชื่อคนขับ'), radius: 12)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 11),
          FieldLabel(loc.t('ประเภทรถ')),
          DropdownButtonFormField<String>(
            value: c.outVehicleType.isEmpty ? null : c.outVehicleType,
            isExpanded: true,
            decoration: pdaInput(loc.t('— เลือกประเภทรถ —'), radius: 12),
            hint: Text(loc.t('— เลือกประเภทรถ —'),
                style: TextStyle(color: C.faint)),
            items: _vehicleTypes
                .map((t) => DropdownMenuItem(value: t, child: Text(loc.t(t))))
                .toList(),
            onChanged: (v) => c.setOutVehicleType(v ?? ''),
          ),
          if (c.outVehicleType == 'อื่นๆ') ...[
            const SizedBox(height: 9),
            FieldLabel(loc.t('ระบุประเภทรถ *')),
            TextField(
                controller: _outVtypeOtherCtrl,
                onChanged: c.setOutVehicleTypeOther,
                decoration: pdaInput(loc.t('เช่น รถตู้ / รถพ่วง'), radius: 12)),
          ],
          const SizedBox(height: 8),
          Text(loc.t('เลขที่ DO/PO จะสร้างอัตโนมัติเมื่อยืนยันส่งออก'),
              style: TextStyle(fontSize: 11.5, color: C.muted)),
        ],
      ),
    );
  }

  Widget _inForm(AppController c, LocaleController loc) {
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    FieldLabel(loc.t('ทะเบียนรถ')),
                    TextField(
                        controller: _inPlateCtrl,
                        onChanged: c.setInPlate,
                        decoration: pdaInput('82-1234 กทม', radius: 12)),
                  ],
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    FieldLabel(loc.t('คนขับ')),
                    TextField(
                        controller: _inDriverCtrl,
                        onChanged: c.setInDriver,
                        decoration: pdaInput(loc.t('ชื่อคนขับ'), radius: 12)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 11),
          FieldLabel(loc.t('ประเภทรถ')),
          DropdownButtonFormField<String>(
            value: c.inVehicleType.isEmpty ? null : c.inVehicleType,
            isExpanded: true,
            decoration: pdaInput(loc.t('— เลือกประเภทรถ —'), radius: 12),
            hint: Text(loc.t('— เลือกประเภทรถ —'),
                style: TextStyle(color: C.faint)),
            items: _vehicleTypes
                .map((t) => DropdownMenuItem(value: t, child: Text(loc.t(t))))
                .toList(),
            onChanged: (v) => c.setInVehicleType(v ?? ''),
          ),
          if (c.inVehicleType == 'อื่นๆ') ...[
            const SizedBox(height: 9),
            FieldLabel(loc.t('ระบุประเภทรถ *')),
            TextField(
                controller: _inVtypeOtherCtrl,
                onChanged: c.setInVehicleTypeOther,
                decoration: pdaInput(loc.t('เช่น รถตู้ / รถพ่วง'), radius: 12)),
          ],
          const SizedBox(height: 16),
          _receiveLocationSection(c, loc),
        ],
      ),
    );
  }

  /// Which putaway strategy this batch uses. Only the choice itself lives
  /// here — no location fields. Receiving happens at the gate; deciding and
  /// confirming a shelf happens at the shelf, after the boxes are actually in
  /// hand (see the putaway step in [_onPrimary]). Asking for a shelf on this
  /// form would be asking before the system knows what is even being received.
  Widget _receiveLocationSection(AppController c, LocaleController loc) {
    final mode = c.receiveLocationMode;
    final hint = switch (mode) {
      ReceiveLocationMode.auto =>
        'ระบบจะกำหนดชั้นวางให้หลังยิงกล่องครบ แล้วพาไปเก็บทีละจุด',
      ReceiveLocationMode.manual =>
        'ยิงกล่องให้ครบก่อน แล้วค่อยเดินไปหาช่องว่างและยิงบาร์โค้ดชั้นวางเอง',
      ReceiveLocationMode.defer =>
        'รับเข้าอย่างเดียว — พักไว้ให้คนจัดเก็บมาเอาขึ้นชั้นทีหลัง',
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        FieldLabel(loc.t('เก็บที่ไหน')),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            ChoiceChip(
              label: Text(loc.t('ตามระบบแนะนำ')),
              selected: mode == ReceiveLocationMode.auto,
              onSelected: (_) =>
                  c.setReceiveLocationMode(ReceiveLocationMode.auto),
            ),
            ChoiceChip(
              label: Text(loc.t('เลือกเอง')),
              selected: mode == ReceiveLocationMode.manual,
              onSelected: (_) =>
                  c.setReceiveLocationMode(ReceiveLocationMode.manual),
            ),
            ChoiceChip(
              label: Text(loc.t('รอ Putaway')),
              selected: mode == ReceiveLocationMode.defer,
              onSelected: (_) =>
                  c.setReceiveLocationMode(ReceiveLocationMode.defer),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
                mode == ReceiveLocationMode.defer
                    ? Icons.inventory_2_outlined
                    : Icons.info_outline,
                size: 15,
                color: C.muted),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                  mode == ReceiveLocationMode.defer
                      ? '${loc.t(hint)} (${c.pendingPutawayLocationLabel})'
                      : loc.t(hint),
                  style: TextStyle(fontSize: 12, color: C.muted, height: 1.45)),
            ),
          ],
        ),
      ],
    );
  }

  Widget _scannerPanel(AppController c, LocaleController loc) {
    // Trigger's actually held in RFID mode: collapse the toggle/status card
    // to a slim strip so the boxes landing in the queue below get the
    // screen, not a card that already did its job of picking the mode.
    if (c.scanInputMode == ScanInputMode.rfid && _rfidReading) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: C.limeBg,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: C.limeBorder),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 15,
              height: 15,
              child: CircularProgressIndicator(
                  strokeWidth: 2.2, color: C.limeDeep),
            ),
            const SizedBox(width: 11),
            Text(loc.t('กำลังอ่านแท็ก RFID…'),
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: C.limeDeep)),
          ],
        ),
      );
    }
    final connected =
        c.rfidStatus.state == RfidState.connected || !c.rfid.supported;
    final readyText = !c.rfid.supported
        ? loc.t('โหมดจำลอง')
        : c.rfidStatus.state == RfidState.connected
            ? loc.t('สแกนเนอร์พร้อม')
            : c.rfidStatus.state == RfidState.connecting
                ? loc.t('กำลังเชื่อมต่อ…')
                : loc.t('สแกนเนอร์ไม่พร้อม');
    // This card repaints on every scan while the trigger's held — a
    // gradient background is a per-frame cost that flat color isn't, and
    // this is the one background in the app redrawing at scan speed rather
    // than on a UI tap.
    final lowPower = c.lowPowerMode;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: lowPower ? const Color(0xFFECEEEF) : null,
        gradient: lowPower
            ? null
            : const LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0xFFF3F3F5), Color(0xFFE7E7EA)]),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: C.border2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('GATE · ${c.mode == 'in' ? 'INBOUND' : 'OUTBOUND'}',
                  style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.2,
                      color: C.muted)),
              Row(
                children: [
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: connected ? C.lime : C.orange,
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(
                            color: (connected ? C.limeBg : C.orangeBg),
                            blurRadius: 0,
                            spreadRadius: 3)
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(readyText,
                      style: TextStyle(fontSize: 11, color: C.muted)),
                ],
              ),
            ],
          ),
          const SizedBox(height: 11),
          _inputModeToggle(c, loc),
          const SizedBox(height: 11),
          // scan input — Enter (a scanner's trailing keystroke, or the
          // keyboard's "Go"/"Done" action) submits; no separate tap needed.
          // RFID mode drops this entirely: a trigger pull already reaches
          // the queue through AppController._onReaderTag with nothing typed
          // here, so an operator reading tags gets a clean screen instead of
          // a text field they'll never use.
          if (c.scanInputMode == ScanInputMode.barcode)
            TextField(
              controller: _scanCtrl,
              focusNode: _scanFocus,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              autocorrect: false,
              enableSuggestions: false,
              onSubmitted: (_) => _submit(c),
              style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.6,
                  fontFamily: 'monospace'),
              decoration: InputDecoration(
                hintText: loc.t('ยิงบาร์โค้ด หรือพิมพ์รหัส'),
                hintStyle: TextStyle(
                    fontFamily: 'Roboto', color: C.faint, fontSize: 15),
                isDense: true,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 15, vertical: 16),
                filled: true,
                fillColor: C.surface,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: C.ink, width: 1.5),
                ),
              ),
            )
          else
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 22),
              decoration: BoxDecoration(
                color: C.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: C.fieldBorder, width: 1.5),
              ),
              child: Column(
                children: [
                  Icon(Icons.wifi_tethering, size: 22, color: C.muted),
                  const SizedBox(height: 6),
                  Text(loc.t('เหนี่ยวไกเพื่ออ่านแท็ก RFID'),
                      style: TextStyle(
                          fontSize: 13,
                          color: C.muted,
                          fontWeight: FontWeight.w600)),
                ],
              ),
            ),
          if (c.lastResult != null) _resultChip(c.lastResult!),
        ],
      ),
    );
  }

  Widget _inputModeToggle(AppController c, LocaleController loc) {
    Widget seg(ScanInputMode m, String label, IconData icon) {
      final selected = c.scanInputMode == m;
      return Expanded(
        child: GestureDetector(
          onTap: () {
            if (c.scanInputMode == m) return;
            c.setScanInputMode(m);
            if (m == ScanInputMode.barcode) {
              WidgetsBinding.instance
                  .addPostFrameCallback((_) => _scanFocus.requestFocus());
            } else {
              // Nothing left on screen worth the keyboard's space.
              _scanFocus.unfocus();
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
      decoration: BoxDecoration(
          color: C.neutralBg2, borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          seg(ScanInputMode.barcode, loc.t('บาร์โค้ด'), Icons.qr_code_scanner),
          seg(ScanInputMode.rfid, 'RFID', Icons.wifi_tethering),
        ],
      ),
    );
  }

  Widget _resultChip(ScanResult r) {
    late Color col, bg, bd;
    switch (r.kind) {
      case ResultKind.ok:
        col = C.limeDeep;
        bg = C.limeBg;
        bd = C.limeBorder;
        break;
      case ResultKind.err:
        col = C.red;
        bg = C.redBg;
        bd = C.redBorder;
        break;
      case ResultKind.warn:
        col = C.orange;
        bg = C.orangeBg;
        bd = C.orangeBorder;
        break;
      case ResultKind.info:
        col = C.ink3;
        bg = C.neutralBg;
        bd = C.border2;
        break;
    }
    return Container(
      margin: const EdgeInsets.only(top: 11),
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: bd)),
      child: Text.rich(
        TextSpan(
          style: TextStyle(
              fontSize: 13.5, fontWeight: FontWeight.w500, color: col),
          children: [
            TextSpan(
                text: r.tag,
                style: const TextStyle(
                    fontFamily: 'monospace', fontWeight: FontWeight.w700)),
            TextSpan(text: r.tag.isEmpty ? r.msg : ' · ${r.msg}'),
          ],
        ),
      ),
    );
  }

  Widget _queueHeader(AppController c, LocaleController loc) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text('${loc.t('คิวสแกน')} · ${c.queue.length} ${loc.t('ใบ')}',
              style: TextStyle(
                  fontSize: 13, fontWeight: FontWeight.w700, color: C.ink)),
          if (c.queue.isNotEmpty)
            GestureDetector(
              onTap: c.clearQueue,
              child: Text(loc.t('ล้างคิว'),
                  style: TextStyle(
                      fontSize: 12.5,
                      color: C.muted,
                      fontWeight: FontWeight.w500)),
            ),
        ],
      ),
    );
  }

  List<Widget> _queueList(AppController c, LocaleController loc) {
    if (c.queue.isEmpty) {
      return [
        Padding(
          padding: EdgeInsets.symmetric(vertical: 26, horizontal: 16),
          child: Center(
            child: Text(loc.t('ยังไม่มีกล่องในคิว — ยิงบาร์โค้ดเพื่อเริ่ม'),
                style: TextStyle(fontSize: 13, color: C.faint)),
          ),
        )
      ];
    }
    final S = c.S;
    // Newest scan on top. Reversed at render rather than by inserting at the
    // head of `queue`, because the queue itself is submitted to the gate and
    // reused by simBurst/removeFromQueue — display order is a display concern
    // and shouldn't quietly change what gets sent.
    return c.queue.reversed.map((t) {
      final b = S?.box(t);
      final isRet = b?.everShipped ?? false;
      late String badge;
      late Color bc, bbg;
      if (c.mode == 'in') {
        if (isRet) {
          badge = '${loc.t('คืน')} · ${(b?.cycles ?? 0) + 1}';
          bc = C.limeText;
          bbg = C.limeBg;
        } else {
          badge = loc.t('ใหม่');
          bc = C.ink2;
          bbg = C.neutralBg;
        }
      } else {
        badge = loc.t('พร้อมจ่าย');
        bc = C.ink2;
        bbg = C.neutralBg;
      }
      final condition = c.queueConditions[t];
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
          decoration: BoxDecoration(
            color: C.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
                color: condition != null ? C.orangeBorder : C.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(
                        color: C.neutralBg2,
                        borderRadius: BorderRadius.circular(9)),
                    child: Icon(Icons.inventory_2_outlined,
                        size: 18, color: C.muted),
                  ),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(t,
                            style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w700,
                                fontFamily: 'monospace',
                                letterSpacing: 0.4)),
                        Text(S?.typeName(b?.type) ?? '-',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 12, color: C.muted)),
                      ],
                    ),
                  ),
                  Pill(badge, color: bc, bg: bbg),
                  const SizedBox(width: 6),
                  GestureDetector(
                    onTap: () => c.removeFromQueue(t),
                    child: SizedBox(
                        width: 28,
                        height: 28,
                        child: Icon(Icons.close, size: 17, color: C.chevron)),
                  ),
                ],
              ),
              // เฉพาะรับเข้า/รับคืน — กล่องชำรุดจ่ายออกไม่ได้อยู่แล้ว
              // (backend ปฏิเสธ) ตัวเลือกนี้จึงไม่มีความหมายฝั่งส่งออก
              if (c.mode == 'in') ...[
                const SizedBox(height: 8),
                _ConditionPicker(
                  value: condition,
                  onChanged: (v) => c.setQueueCondition(t, v),
                ),
              ],
            ],
          ),
        ),
      );
    }).toList();
  }
}

/// Lets the operator flag a box as damaged or on-hold right as it's scanned
/// into the Gate In queue, mirroring the status the web dashboard's own box
/// list already filters by (ชำรุด/Hold) — copied here since receiving is
/// exactly where damage is first noticed, not after it's already back on a
/// shelf.
class _ConditionPicker extends StatelessWidget {
  final String? value;
  final ValueChanged<String?> onChanged;
  const _ConditionPicker({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocaleController>();
    Widget chip(String? v, String label, Color c, Color bg) {
      final selected = value == v;
      return Expanded(
        child: GestureDetector(
          onTap: () => onChanged(selected ? null : v),
          child: Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(vertical: 7),
            decoration: BoxDecoration(
              color: selected ? bg : C.neutralBg,
              borderRadius: BorderRadius.circular(9),
              border: Border.all(color: selected ? c : C.border),
            ),
            child: Text(label,
                style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                    color: selected ? c : C.muted)),
          ),
        ),
      );
    }

    return Row(
      children: [
        chip(null, loc.t('ปกติ'), C.limeText, C.limeBg),
        const SizedBox(width: 6),
        chip('damage', loc.t('ชำรุด'), C.red, C.redBg),
        const SizedBox(width: 6),
        chip('hold', loc.t('พัก (Hold)'), C.orange, C.orangeBg),
      ],
    );
  }
}
