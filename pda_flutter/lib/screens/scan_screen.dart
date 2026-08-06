import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/api_client.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});
  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

const _vehicleTypes = ['รถกระบะ', 'รถบรรทุก 6 ล้อ', 'รถบรรทุก 10 ล้อ', 'รถเทรลเลอร์', 'อื่นๆ'];

class _ScanScreenState extends State<ScanScreen> {
  final _scanCtrl = TextEditingController();
  final _plateCtrl = TextEditingController();
  final _driverCtrl = TextEditingController();
  final _outVtypeOtherCtrl = TextEditingController();
  final _inPlateCtrl = TextEditingController();
  final _inDriverCtrl = TextEditingController();
  final _inVtypeOtherCtrl = TextEditingController();
  final _scanFocus = FocusNode();
  final _plateFocus = FocusNode();

  /// Scan-then-details, same shape on both directions: the operator isn't
  /// looking at customer/vehicle fields before they've even started scanning
  /// boxes. "ถัดไป" reveals the form; the actual commit only happens from
  /// there. Reset is implicit — setMode() always routes through a fresh
  /// ScanScreen instance (see root_screen.dart's ValueKey), so this never
  /// needs to be cleared by hand between Gate In and Gate Out.
  bool _detailsStep = false;

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
    _plateFocus.dispose();
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

  /// First tap just reveals the customer/vehicle form (label becomes
  /// "ยืนยันรับเข้าคลัง"/"ยืนยันส่งออก" at that point); the second tap actually
  /// commits. A failed commit leaves the queue non-empty, which is the
  /// signal to stay on the details step for a retry rather than snapping
  /// back to an empty scan screen.
  Future<void> _onPrimary(AppController c) async {
    if (!_detailsStep) {
      setState(() => _detailsStep = true);
      return;
    }
    await c.doCommit();
    if (!mounted) return;
    if (c.queue.isEmpty) setState(() => _detailsStep = false);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final isOut = c.mode == 'out';
    // ทะเบียนรถ is only mandatory on the way out — Gate In doesn't require it.
    final plateOk = !isOut || c.outPlate.trim().isNotEmpty;
    final vtypeOk = isOut
        ? (c.outVehicleType != 'อื่นๆ' || c.outVehicleTypeOther.trim().isNotEmpty)
        : (c.inVehicleType != 'อื่นๆ' || c.inVehicleTypeOther.trim().isNotEmpty);
    // The form itself is hidden until the details step, so its fields can't
    // block "ถัดไป" — only the actual commit tap needs them valid.
    final formValid = (!isOut || c.outCustomer.isNotEmpty) && plateOk && vtypeOk;
    final canCommit = c.queue.isNotEmpty && (!_detailsStep || formValid);

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: Row(
            children: [
              Pill(isOut ? 'ออก' : 'เข้า',
                  color: isOut ? C.orange : C.limeText, bg: isOut ? C.orangeBg : C.limeBg),
              const SizedBox(width: 7),
              Text(isOut ? 'ส่งออก' : 'รับคืน'),
            ],
          ),
          subtitle: Text('${c.selWhName} · ประตู ${c.gate}'),
          actions: [OnlineChip(online: c.connected, onTap: c.retryOrConfigure)],
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 120),
            // Details step shows only the vehicle form — not the scanner
            // panel (with its บาร์โค้ด/RFID toggle, which has nothing to do
            // once scanning's done) and not the queue list, which the "×N"
            // badge on the bottom button already accounts for. "กลับไปสแกน
            // กล่องเพิ่ม" is the way back to the scan step if either needs
            // to be seen or changed again.
            children: _detailsStep
                ? [
                    GestureDetector(
                      onTap: () => setState(() => _detailsStep = false),
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 9),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.chevron_left, size: 17, color: C.muted),
                            Text('กลับไปสแกนกล่องเพิ่ม',
                                style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w600)),
                          ],
                        ),
                      ),
                    ),
                    isOut ? _outForm(c) : _inForm(c),
                  ]
                : [
                    _scannerPanel(c),
                    const SizedBox(height: 13),
                    _queueHeader(c),
                    const SizedBox(height: 8),
                    ..._queueList(c),
                  ],
          ),
        ),
        // Nothing scanned yet: no "ถัดไป" to press, so there's no button to
        // show — a disabled button still invites a tap and a "why won't this
        // work" moment before the first scan has even landed.
        if (c.queue.isNotEmpty)
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
              label: !_detailsStep ? 'ถัดไป' : (isOut ? 'ยืนยันส่งออก' : 'ยืนยันรับคืน'),
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                decoration: BoxDecoration(
                    color: C.limeDeep.withOpacity(0.16), borderRadius: BorderRadius.circular(999)),
                child: Text('${c.queue.length}',
                    style: TextStyle(
                        fontSize: 14, color: C.limeDeep, fontFeatures: [FontFeature.tabularFigures()])),
              ),
              onTap: (canCommit && !c.busy) ? () => _onPrimary(c) : null,
            ),
          ),
      ],
    );
  }

  Widget _outForm(AppController c) {
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const FieldLabel('ลูกค้าปลายทาง *'),
          AddableDropdown(
            value: c.outCustomer.isEmpty ? null : c.outCustomer,
            options: c.customerList.map((cust) => (cust['id'] ?? '').toString()).toList(),
            labelFor: (id) {
              final cust = c.customerList.firstWhere((x) => (x['id'] ?? '').toString() == id, orElse: () => {});
              return '$id · ${cust['name'] ?? ''}';
            },
            hint: '— เลือกลูกค้า —',
            nextFocus: _plateFocus,
            onChanged: (v) => c.setOutCustomer(v ?? ''),
            onAdd: (typed) async {
              final id = typed.toUpperCase().replaceAll(RegExp(r'\s+'), '_');
              try {
                await c.api.createCustomer(id, typed);
                await c.refresh();
                return id;
              } catch (e) {
                c.toastMsg('เพิ่มลูกค้าไม่สำเร็จ', e is ApiException ? e.message : '', ResultKind.err);
                return null;
              }
            },
          ),
          const SizedBox(height: 11),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const FieldLabel('ทะเบียนรถ *'),
                    TextField(controller: _plateCtrl, focusNode: _plateFocus, onChanged: c.setOutPlate, decoration: pdaInput('82-1234 กทม', radius: 12)),
                  ],
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const FieldLabel('คนขับ'),
                    TextField(controller: _driverCtrl, onChanged: c.setOutDriver, decoration: pdaInput('ชื่อคนขับ', radius: 12)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 11),
          const FieldLabel('ประเภทรถ'),
          DropdownButtonFormField<String>(
            value: c.outVehicleType.isEmpty ? null : c.outVehicleType,
            isExpanded: true,
            decoration: pdaInput('— เลือกประเภทรถ —', radius: 12),
            hint: Text('— เลือกประเภทรถ —', style: TextStyle(color: C.faint)),
            items: _vehicleTypes.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
            onChanged: (v) => c.setOutVehicleType(v ?? ''),
          ),
          if (c.outVehicleType == 'อื่นๆ') ...[
            const SizedBox(height: 9),
            const FieldLabel('ระบุประเภทรถ *'),
            TextField(
                controller: _outVtypeOtherCtrl,
                onChanged: c.setOutVehicleTypeOther,
                decoration: pdaInput('เช่น รถตู้ / รถพ่วง', radius: 12)),
          ],
          const SizedBox(height: 8),
          Text('เลขที่ DO/PO จะสร้างอัตโนมัติเมื่อยืนยันส่งออก',
              style: TextStyle(fontSize: 11.5, color: C.muted)),
        ],
      ),
    );
  }

  Widget _inForm(AppController c) {
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
                    const FieldLabel('ทะเบียนรถ'),
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
                    const FieldLabel('คนขับ'),
                    TextField(
                        controller: _inDriverCtrl,
                        onChanged: c.setInDriver,
                        decoration: pdaInput('ชื่อคนขับ', radius: 12)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 11),
          const FieldLabel('ประเภทรถ'),
          DropdownButtonFormField<String>(
            value: c.inVehicleType.isEmpty ? null : c.inVehicleType,
            isExpanded: true,
            decoration: pdaInput('— เลือกประเภทรถ —', radius: 12),
            hint: Text('— เลือกประเภทรถ —', style: TextStyle(color: C.faint)),
            items: _vehicleTypes.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
            onChanged: (v) => c.setInVehicleType(v ?? ''),
          ),
          if (c.inVehicleType == 'อื่นๆ') ...[
            const SizedBox(height: 9),
            const FieldLabel('ระบุประเภทรถ *'),
            TextField(
                controller: _inVtypeOtherCtrl,
                onChanged: c.setInVehicleTypeOther,
                decoration: pdaInput('เช่น รถตู้ / รถพ่วง', radius: 12)),
          ],
        ],
      ),
    );
  }

  Widget _scannerPanel(AppController c) {
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
              child: CircularProgressIndicator(strokeWidth: 2.2, color: C.limeText),
            ),
            const SizedBox(width: 11),
            Text('กำลังอ่านแท็ก RFID…',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: C.limeText)),
          ],
        ),
      );
    }
    final connected = c.rfidStatus.state == RfidState.connected || !c.rfid.supported;
    final readyText = !c.rfid.supported
        ? 'โหมดจำลอง'
        : c.rfidStatus.state == RfidState.connected
            ? 'สแกนเนอร์พร้อม'
            : c.rfidStatus.state == RfidState.connecting
                ? 'กำลังเชื่อมต่อ…'
                : 'สแกนเนอร์ไม่พร้อม';
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
                begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFFF3F3F5), Color(0xFFE7E7EA)]),
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
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1.2, color: C.muted)),
              Row(
                children: [
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: connected ? C.lime : C.orange,
                      shape: BoxShape.circle,
                      boxShadow: [BoxShadow(color: (connected ? C.limeBg : C.orangeBg), blurRadius: 0, spreadRadius: 3)],
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(readyText, style: TextStyle(fontSize: 11, color: C.muted)),
                ],
              ),
            ],
          ),
          const SizedBox(height: 11),
          _inputModeToggle(c),
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
                  fontSize: 20, fontWeight: FontWeight.w600, letterSpacing: 0.6, fontFamily: 'monospace'),
              decoration: InputDecoration(
                hintText: 'ยิงบาร์โค้ด หรือพิมพ์รหัส',
                hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 15),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 15, vertical: 16),
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
                  Text('เหนี่ยวไกเพื่ออ่านแท็ก RFID',
                      style: TextStyle(fontSize: 13, color: C.muted, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
          if (c.lastResult != null) _resultChip(c.lastResult!),
        ],
      ),
    );
  }

  Widget _inputModeToggle(AppController c) {
    Widget seg(ScanInputMode m, String label, IconData icon) {
      final selected = c.scanInputMode == m;
      return Expanded(
        child: GestureDetector(
          onTap: () {
            if (c.scanInputMode == m) return;
            c.setScanInputMode(m);
            if (m == ScanInputMode.barcode) {
              WidgetsBinding.instance.addPostFrameCallback((_) => _scanFocus.requestFocus());
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
      decoration: BoxDecoration(color: C.neutralBg2, borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          seg(ScanInputMode.barcode, 'บาร์โค้ด', Icons.qr_code_scanner),
          seg(ScanInputMode.rfid, 'RFID', Icons.wifi_tethering),
        ],
      ),
    );
  }

  Widget _resultChip(ScanResult r) {
    late Color col, bg, bd;
    switch (r.kind) {
      case ResultKind.ok:
        col = C.limeText;
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
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12), border: Border.all(color: bd)),
      child: Text.rich(
        TextSpan(
          style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, color: col),
          children: [
            TextSpan(text: r.tag, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700)),
            TextSpan(text: r.tag.isEmpty ? r.msg : ' · ${r.msg}'),
          ],
        ),
      ),
    );
  }

  Widget _queueHeader(AppController c) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text('คิวสแกน · ${c.queue.length} ใบ',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: C.ink)),
          if (c.queue.isNotEmpty)
            GestureDetector(
              onTap: c.clearQueue,
              child: Text('ล้างคิว', style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w500)),
            ),
        ],
      ),
    );
  }

  List<Widget> _queueList(AppController c) {
    if (c.queue.isEmpty) {
      return [
        Padding(
          padding: EdgeInsets.symmetric(vertical: 26, horizontal: 16),
          child: Center(
            child: Text('ยังไม่มีกล่องในคิว — ยิงบาร์โค้ดเพื่อเริ่ม',
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
          badge = 'คืน · ${(b?.cycles ?? 0) + 1}';
          bc = C.limeText;
          bbg = C.limeBg;
        } else {
          badge = 'ใหม่';
          bc = C.ink2;
          bbg = C.neutralBg;
        }
      } else {
        badge = 'พร้อมจ่าย';
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
            border: Border.all(color: condition != null ? C.orangeBorder : C.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(color: C.neutralBg2, borderRadius: BorderRadius.circular(9)),
                    child: Icon(Icons.inventory_2_outlined, size: 18, color: C.muted),
                  ),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(t,
                            style: const TextStyle(
                                fontSize: 15, fontWeight: FontWeight.w700, fontFamily: 'monospace', letterSpacing: 0.4)),
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
                        width: 28, height: 28, child: Icon(Icons.close, size: 17, color: C.chevron)),
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
        chip(null, 'ปกติ', C.limeText, C.limeBg),
        const SizedBox(width: 6),
        chip('damage', 'ชำรุด', C.red, C.redBg),
        const SizedBox(width: 6),
        chip('hold', 'พัก (Hold)', C.orange, C.orangeBg),
      ],
    );
  }
}
