import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Opens the RFID raw-field test-read sheet — see [_RfidTestSheet].
Future<void> showRfidTestSheet(BuildContext context) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => const _RfidTestSheet(),
  );
}

/// Diagnostics tool: hold the trigger near a tag and see exactly what fields
/// the Zebra SDK reports for it (EPC, TID, PC, CRC, RSSI, antenna, channel,
/// phase, seen count) — so it's clear what this SDK actually reads before
/// building anything that depends on a field like TID being populated.
class _RfidTestSheet extends StatefulWidget {
  const _RfidTestSheet();

  @override
  State<_RfidTestSheet> createState() => _RfidTestSheetState();
}

class _RfidTestSheetState extends State<_RfidTestSheet> {
  final List<RfidTagRead> _reads = [];
  StreamSubscription? _sub;
  bool _reading = false;
  /// Held for [dispose], which can't reach the provider through `context`.
  late final RfidService _rfid;

  @override
  void initState() {
    super.initState();
    final rfid = context.read<AppController>().rfid;
    _rfid = rfid;
    // A diagnostics screen whose whole point is showing every reported field
    // needs the explicit TID read; the streaming screens leave it off because
    // it stalls the inventory (see RfidService.setTidLookup).
    rfid.setTidLookup(true);
    _sub = rfid.rawTags.listen((r) {
      if (!mounted) return;
      setState(() => _reads.insert(0, r));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _rfid.setTidLookup(false);
    if (_reading) _rfid.stopInventory();
    super.dispose();
  }

  Future<void> _toggle() async {
    final rfid = context.read<AppController>().rfid;
    if (_reading) {
      await rfid.stopInventory();
      setState(() => _reading = false);
    } else {
      setState(() => _reading = true);
      await rfid.startInventory();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;

    return DraggableScrollableSheet(
      initialChildSize: 0.85,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      expand: false,
      builder: (context, scrollCtrl) {
        return Container(
          decoration: BoxDecoration(
            color: C.bg,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
          ),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('ทดสอบอ่านแท็ก RFID',
                              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                          Text('อ่านค่าดิบทุกฟิลด์ที่ SDK รายงาน — EPC, TID, PC, CRC, RSSI ฯลฯ',
                              style: TextStyle(fontSize: 12, color: C.muted)),
                        ],
                      ),
                    ),
                    IconButton(
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: c.rfid.supported ? _toggle : null,
                        style: FilledButton.styleFrom(
                          backgroundColor: _reading ? C.red : C.lime,
                          foregroundColor: _reading ? C.onInk : C.limeDeep,
                          padding: const EdgeInsets.symmetric(vertical: 13),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
                        ),
                        icon: Icon(_reading ? Icons.stop : Icons.wifi_tethering),
                        label: Text(_reading ? 'หยุดอ่าน' : 'เริ่มอ่าน'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    OutlinedButton(
                      onPressed: _reads.isEmpty ? null : () => setState(_reads.clear),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: C.ink,
                        side: BorderSide(color: C.border2),
                        padding: const EdgeInsets.symmetric(vertical: 13, horizontal: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
                      ),
                      child: const Text('ล้างรายการ'),
                    ),
                  ],
                ),
              ),
              if (!c.rfid.supported)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                  child: Text(
                    'ใช้ได้เฉพาะบนเครื่อง Android ที่มีเครื่องอ่าน Zebra',
                    style: TextStyle(fontSize: 12, color: C.muted),
                  ),
                ),
              const SizedBox(height: 6),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(
                  children: [
                    Text('อ่านได้ ${_reads.length} ครั้ง', style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Expanded(
                child: _reads.isEmpty
                    ? Center(
                        child: Text('กด "เริ่มอ่าน" แล้วนำแท็กเข้าใกล้เครื่องอ่าน',
                            style: TextStyle(fontSize: 13, color: C.faint)),
                      )
                    : ListView.builder(
                        controller: scrollCtrl,
                        padding: EdgeInsets.fromLTRB(16, 0, 16, bottom + 16),
                        itemCount: _reads.length,
                        itemBuilder: (context, i) => _TagCard(read: _reads[i]),
                      ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _TagCard extends StatelessWidget {
  final RfidTagRead read;
  const _TagCard({required this.read});

  @override
  Widget build(BuildContext context) {
    final t = read.readAt;
    final ts =
        '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')}.${t.millisecond.toString().padLeft(3, '0')}';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Panel(
        padding: const EdgeInsets.all(14),
        radius: 16,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    read.epc.isEmpty ? '—' : read.epc,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w700,
                      fontFamily: kMono.first,
                      fontFamilyFallback: kMono,
                      color: C.ink,
                    ),
                  ),
                ),
                Text(ts, style: TextStyle(fontSize: 11, color: C.faint)),
              ],
            ),
            const SizedBox(height: 10),
            Divider(height: 1, color: C.border),
            const SizedBox(height: 10),
            Wrap(
              spacing: 18,
              runSpacing: 6,
              children: [
                _field('TID', read.tid),
                _field('PC', read.pc?.toRadixString(16).toUpperCase()),
                _field('CRC', read.crc),
                _field('RSSI', read.rssi?.toString()),
                _field('Antenna', read.antenna?.toString()),
                _field('Channel', read.channel),
                _field('Phase', read.phase?.toString()),
                _field('Seen', read.seenCount?.toString()),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(String label, String? value) {
    final text = (value == null || value.isEmpty) ? '—' : value;
    return SizedBox(
      width: 130,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 10.5, color: C.muted)),
          Text(text,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                fontFamily: kMono.first,
                fontFamilyFallback: kMono,
                color: text == '—' ? C.faint : C.ink,
              )),
        ],
      ),
    );
  }
}
