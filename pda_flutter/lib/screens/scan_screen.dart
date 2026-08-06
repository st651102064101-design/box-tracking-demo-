import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
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

  @override
  void dispose() {
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

  void _submit(AppController c) {
    final v = _scanCtrl.text.trim();
    if (v.isEmpty) return;
    c.addScan(v);
    _scanCtrl.clear();
    _scanFocus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final isOut = c.mode == 'out';
    final plateOk = (isOut ? c.outPlate : c.inPlate).trim().isNotEmpty;
    final vtypeOk = isOut
        ? (c.outVehicleType != 'อื่นๆ' || c.outVehicleTypeOther.trim().isNotEmpty)
        : (c.inVehicleType != 'อื่นๆ' || c.inVehicleTypeOther.trim().isNotEmpty);
    final canCommit =
        c.queue.isNotEmpty && (!isOut || c.outCustomer.isNotEmpty) && plateOk && vtypeOk;

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: Row(
            children: [
              Pill(isOut ? 'ออก' : 'เข้า',
                  color: isOut ? C.orange : C.limeDeep, bg: isOut ? C.orangeBg : C.limeBg),
              const SizedBox(width: 7),
              Text(isOut ? 'ส่งออก' : 'รับเข้า / รับคืน'),
            ],
          ),
          subtitle: Text('${c.selWhName} · ประตู ${c.gate}'),
          actions: [OnlineChip(online: c.online, onTap: c.toggleOnline)],
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 120),
            children: [
              if (isOut) _outForm(c) else _inForm(c),
              const SizedBox(height: 13),
              _scannerPanel(c),
              const SizedBox(height: 13),
              _queueHeader(c),
              const SizedBox(height: 8),
              ..._queueList(c),
            ],
          ),
        ),
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
            label: isOut ? 'ยืนยันส่งออก' : 'ยืนยันรับเข้าคลัง',
            trailing: c.queue.isEmpty
                ? null
                : Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                    decoration: BoxDecoration(
                        color: C.limeDeep.withOpacity(0.16), borderRadius: BorderRadius.circular(999)),
                    child: Text('${c.queue.length}',
                        style: TextStyle(
                            fontSize: 14, color: C.limeDeep, fontFeatures: [FontFeature.tabularFigures()])),
                  ),
            onTap: (canCommit && !c.busy) ? c.doCommit : null,
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
          DropdownButtonFormField<String>(
            value: c.outCustomer.isEmpty ? null : c.outCustomer,
            isExpanded: true,
            decoration: pdaInput('— เลือกลูกค้า —', radius: 12),
            hint: Text('— เลือกลูกค้า —', style: TextStyle(color: C.faint)),
            items: c.customerList.map((cust) {
              final id = (cust['id'] ?? '').toString();
              return DropdownMenuItem(value: id, child: Text('$id · ${cust['name'] ?? ''}', overflow: TextOverflow.ellipsis));
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
                    const FieldLabel('ทะเบียนรถ *'),
                    TextField(controller: _plateCtrl, onChanged: c.setOutPlate, decoration: pdaInput('82-1234 กทม', radius: 12)),
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
    final connected = c.rfidStatus.state == RfidState.connected || !c.rfid.supported;
    final readyText = !c.rfid.supported
        ? 'โหมดจำลอง'
        : c.rfidStatus.state == RfidState.connected
            ? 'สแกนเนอร์พร้อม'
            : c.rfidStatus.state == RfidState.connecting
                ? 'กำลังเชื่อมต่อ…'
                : 'สแกนเนอร์ไม่พร้อม';
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
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
          // scan input
          Row(
            children: [
              Expanded(
                child: TextField(
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
                    hintText: 'ยิงบาร์โค้ด / RFID หรือพิมพ์รหัส',
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
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 44,
                height: 52,
                child: FilledButton(
                  onPressed: () => _submit(c),
                  style: FilledButton.styleFrom(
                    backgroundColor: C.ink,
                    padding: EdgeInsets.zero,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                  child: const Icon(Icons.add, size: 22),
                ),
              ),
            ],
          ),
          if (c.lastResult != null) _resultChip(c.lastResult!),
          const SizedBox(height: 12),
          // trigger + simulator
          Row(
            children: [
              Expanded(
                child: _sim('ยิง / อ่านครั้งเดียว', () async {
                  if (c.rfid.supported && c.rfidStatus.state == RfidState.connected) {
                    await c.rfid.startInventory();
                    await Future.delayed(const Duration(milliseconds: 600));
                    await c.rfid.stopInventory();
                  } else {
                    c.simOne();
                  }
                }),
              ),
              const SizedBox(width: 8),
              Expanded(child: _sim('จำลอง RFID 5 ใบ', () => c.simBurst(5))),
            ],
          ),
        ],
      ),
    );
  }

  Widget _sim(String label, VoidCallback onTap) => OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          foregroundColor: C.ink3,
          backgroundColor: Colors.black.withOpacity(0.05),
          side: BorderSide(color: Colors.black.withOpacity(0.1)),
          padding: const EdgeInsets.symmetric(vertical: 9),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        ),
        child: Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
      );

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
    return c.queue.map((t) {
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
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
          decoration: BoxDecoration(
            color: C.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: C.border),
          ),
          child: Row(
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
        ),
      );
    }).toList();
  }
}
