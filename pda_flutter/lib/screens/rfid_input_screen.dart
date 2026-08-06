import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// One tag read: every raw SDK field it came with, plus when it arrived.
/// Newest first. A manually-typed code (no trigger pull involved) only ever
/// has an EPC — everything else stays null.
class _Read {
  final String epc;
  final DateTime at;
  final String? tid;
  final int? rssi;
  final int? pc;
  final String? crc;
  final int? antenna;
  final String? channel;
  final int? phase;
  final int? seenCount;
  const _Read(
    this.epc,
    this.at, {
    this.tid,
    this.rssi,
    this.pc,
    this.crc,
    this.antenna,
    this.channel,
    this.phase,
    this.seenCount,
  });

  factory _Read.fromTagRead(RfidTagRead r, DateTime at) => _Read(
        r.epc,
        at,
        tid: r.tid,
        rssi: r.rssi,
        pc: r.pc,
        crc: r.crc,
        antenna: r.antenna,
        channel: r.channel,
        phase: r.phase,
        seenCount: r.seenCount,
      );

  /// The EPC as the reader gives it (hex) converted to base-10 — a 24-hex-digit
  /// EPC like `000000000000000000000005` reads a lot more like "a tag" and a
  /// lot less like a wall of hex once it's just `5`. BigInt because a full
  /// 96-bit EPC overflows a 64-bit int. Null for anything that isn't valid
  /// hex (e.g. a manually-typed code).
  String? get decimal {
    final hex = epc.replaceAll(RegExp(r'\s'), '');
    if (hex.isEmpty || !RegExp(r'^[0-9A-Fa-f]+$').hasMatch(hex)) return null;
    return BigInt.parse(hex, radix: 16).toString();
  }
}

/// Standalone RFID input screen: connect to the MC3390R reader, hold the
/// trigger (or tap "อ่าน"), and every EPC that comes back lands in the list
/// below — no box lookup, no queue, no backend call. Just a live view of
/// what the reader sees, plus a manual text field for when there's no tag
/// on hand.
class RfidInputScreen extends StatefulWidget {
  const RfidInputScreen({super.key});

  @override
  State<RfidInputScreen> createState() => _RfidInputScreenState();
}

class _RfidInputScreenState extends State<RfidInputScreen> {
  final _manualCtrl = TextEditingController();
  final _reads = <_Read>[];
  StreamSubscription<RfidTagRead>? _tagSub;
  StreamSubscription<RfidStatus>? _statusSub;
  StreamSubscription<bool>? _triggerSub;
  late RfidStatus _status;
  bool _reading = false;
  /// Held so [dispose] can undo the TID-lookup opt-in without reaching for an
  /// InheritedWidget through `context` that late in the lifecycle.
  late final RfidService _rfid;

  @override
  void initState() {
    super.initState();
    final rfid = context.read<AppController>().rfid;
    _rfid = rfid;
    _status = RfidStatus(rfid.state, '');
    // This screen exists to show every field the SDK reports, TID included,
    // so it opts into the explicit TID read that the streaming screens
    // deliberately leave off (it stalls the inventory — see
    // RfidService.setTidLookup). Turned back off in dispose.
    rfid.setTidLookup(true);
    _tagSub = rfid.tagReads.listen((r) {
      setState(() => _reads.insert(0, _Read.fromTagRead(r, DateTime.now())));
    });
    _statusSub = rfid.status.listen((s) => setState(() => _status = s));
    // The physical gun trigger drives start/stopInventory from AppController
    // (see _onReaderTrigger) — mirror that here so the on-screen button stays
    // in sync whether the read was started by a tap or a trigger pull.
    _triggerSub = rfid.triggers.listen((pressed) => setState(() => _reading = pressed));
    if (rfid.supported && rfid.state != RfidState.connected) {
      rfid.connect();
    }
  }

  @override
  void dispose() {
    _tagSub?.cancel();
    _statusSub?.cancel();
    _triggerSub?.cancel();
    _rfid.setTidLookup(false);
    _manualCtrl.dispose();
    super.dispose();
  }

  Future<void> _toggleRead(AppController c) async {
    if (!c.rfid.supported) return;
    if (_reading) {
      await c.rfid.stopInventory();
      setState(() => _reading = false);
    } else {
      setState(() => _reading = true);
      await c.rfid.startInventory();
    }
  }

  void _addManual() {
    final v = _manualCtrl.text.trim();
    if (v.isEmpty) return;
    setState(() => _reads.insert(0, _Read(v, DateTime.now())));
    _manualCtrl.clear();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final connected = _status.state == RfidState.connected;

    return Column(
      children: [
        StickyHeader(onBack: c.backToHome, title: const Text('รับค่า RFID')),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 16),
            children: [
              Panel(
                padding: const EdgeInsets.all(16),
                radius: 18,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 11,
                          height: 11,
                          decoration: BoxDecoration(
                            color: connected ? C.lime : (_status.state == RfidState.connecting ? C.orange : C.red),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 11),
                        Expanded(
                          child: Text(
                            !c.rfid.supported
                                ? 'ใช้ได้เฉพาะบนเครื่องอ่าน Zebra'
                                : connected
                                    ? 'เชื่อมต่อเครื่องอ่านแล้ว'
                                    : _status.state == RfidState.connecting
                                        ? 'กำลังเชื่อมต่อ…'
                                        : (_status.message.isEmpty ? 'ยังไม่ได้เชื่อมต่อ' : _status.message),
                            style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: c.rfid.supported ? () => _toggleRead(c) : null,
                        icon: Icon(_reading ? Icons.stop : Icons.wifi_tethering),
                        label: Text(_reading ? 'หยุดอ่าน' : 'เริ่มอ่าน RFID'),
                        style: FilledButton.styleFrom(
                          backgroundColor: _reading ? C.red : C.ink,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _manualCtrl,
                            autocorrect: false,
                            enableSuggestions: false,
                            onSubmitted: (_) => _addManual(),
                            style: const TextStyle(fontFamily: 'monospace', fontSize: 15),
                            decoration: InputDecoration(
                              hintText: 'หรือพิมพ์รหัสเอง',
                              hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 14),
                              isDense: true,
                              contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
                              filled: true,
                              fillColor: C.surface,
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(12),
                                borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        SizedBox(
                          width: 44,
                          height: 46,
                          child: FilledButton(
                            onPressed: _addManual,
                            style: FilledButton.styleFrom(
                              backgroundColor: C.ink,
                              padding: EdgeInsets.zero,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                            ),
                            child: const Icon(Icons.add, size: 20),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('อ่านได้ ${_reads.length} รายการ',
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: C.ink)),
                  if (_reads.isNotEmpty)
                    GestureDetector(
                      onTap: () => setState(_reads.clear),
                      child: Text('ล้างรายการ', style: TextStyle(fontSize: 12.5, color: C.muted)),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              if (_reads.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 26),
                  child: Center(
                    child: Text('ยังไม่มีข้อมูล — กด "เริ่มอ่าน RFID" แล้วยิงแท็ก',
                        style: TextStyle(fontSize: 13, color: C.faint)),
                  ),
                )
              else
                ..._reads.map((r) => Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
                        decoration: BoxDecoration(
                          color: C.surface,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: C.border),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(Icons.nfc, size: 18, color: C.muted),
                                const SizedBox(width: 11),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Text(r.epc,
                                          style: const TextStyle(
                                              fontSize: 15,
                                              fontWeight: FontWeight.w700,
                                              fontFamily: 'monospace',
                                              letterSpacing: 0.4)),
                                      if (r.decimal != null)
                                        Padding(
                                          padding: const EdgeInsets.only(top: 2),
                                          child: Text('เลขฐาน 10: ${r.decimal}',
                                              style: TextStyle(
                                                  fontSize: 12,
                                                  fontFamily: 'monospace',
                                                  color: C.muted)),
                                        ),
                                    ],
                                  ),
                                ),
                                Text(_fmtTime(r.at), style: TextStyle(fontSize: 12, color: C.faint)),
                              ],
                            ),
                            const SizedBox(height: 9),
                            Divider(height: 1, color: C.border),
                            const SizedBox(height: 9),
                            Wrap(
                              spacing: 16,
                              runSpacing: 6,
                              children: [
                                _field('TID', r.tid),
                                _field('PC', r.pc?.toRadixString(16).toUpperCase()),
                                _field('CRC', r.crc),
                                _field('RSSI', r.rssi?.toString()),
                                _field('Antenna', r.antenna?.toString()),
                                _field('Channel', r.channel),
                                _field('Phase', r.phase?.toString()),
                                _field('Seen', r.seenCount?.toString()),
                              ],
                            ),
                          ],
                        ),
                      ),
                    )),
            ],
          ),
        ),
      ],
    );
  }

  String _fmtTime(DateTime t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')}';

  Widget _field(String label, String? value) {
    final text = (value == null || value.isEmpty) ? '—' : value;
    return SizedBox(
      width: 128,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 10.5, color: C.muted)),
          Text(text,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                fontFamily: 'monospace',
                color: text == '—' ? C.faint : C.ink,
              )),
        ],
      ),
    );
  }
}
