import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../models/location.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_capture.dart';

/// "เช็คช่อง" — the reverse of "ย้ายตำแหน่งกล่อง"/"เรดาร์หากล่อง": stand in front
/// of a shelf, scan its own barcode, and see what the system believes is
/// sitting on it right now. Answers "does what's actually here match what's
/// recorded" without knowing a box's tag up front — the complement to
/// scanning a box to find where it's supposed to be.
///
/// Purely client-side: every box's location is already in [StateSnapshot],
/// same data TrackScreen/RelocateScreen already read — no new endpoint
/// needed for this direction.
class LocationInquiryScreen extends StatefulWidget {
  const LocationInquiryScreen({super.key});
  @override
  State<LocationInquiryScreen> createState() => _LocationInquiryScreenState();
}

class _LocationInquiryScreenState extends State<LocationInquiryScreen> {
  Location? _location;
  String? _scanError;

  void _onScan(AppController c, String raw) {
    final s = c.S;
    if (s == null) return;
    final needle = raw.trim().toLowerCase();
    Location? found;
    for (final entry in s.locations.entries) {
      if (entry.key.toLowerCase() != needle) continue;
      if (entry.value.wh != c.wh) continue;
      found = entry.value;
      break;
    }
    if (found == null) {
      setState(() => _scanError = 'ไม่พบตำแหน่งรหัส "$raw"');
      return;
    }
    setState(() {
      _scanError = null;
      _location = found;
    });
  }

  String _locText(Location l) => [l.zone, l.rack, l.shelf, l.slot]
      .where((v) => v.isNotEmpty)
      .join(' / ');

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final l = _location;
    final boxesHere = l == null
        ? const <Box>[]
        : (c.S?.boxes
                .where((b) =>
                    b.status == 'warehouse' &&
                    (b.location['wh'] ?? '').toString() == c.wh &&
                    (b.location['zone'] ?? '').toString() == l.zone &&
                    (b.location['rack'] ?? '').toString() == l.rack &&
                    (b.location['shelf'] ?? '').toString() == l.shelf &&
                    (b.location['slot'] ?? '').toString() == l.slot)
                .toList() ??
            const <Box>[]);

    return ScanCapture(
      enabled: true,
      onScan: (raw) => _onScan(c, raw),
      child: Column(
        children: [
          StickyHeader(
            onBack: c.backToHome,
            title: const Text('เช็คช่อง'),
            subtitle: const Text('ยิงบาร์โค้ดชั้นวางเพื่อดูของที่ควรอยู่'),
          ),
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
              children: [
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                      horizontal: 15, vertical: 18),
                  decoration: BoxDecoration(
                    color: C.surface,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: C.border, width: 1.5),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.qr_code_scanner, color: C.muted),
                      const SizedBox(width: 11),
                      Expanded(
                        child: Text('ยิงบาร์โค้ดชั้นวาง',
                            style: TextStyle(
                                fontSize: 14,
                                color: C.muted,
                                fontWeight: FontWeight.w600)),
                      ),
                    ],
                  ),
                ),
                if (_scanError != null) ...[
                  const SizedBox(height: 10),
                  Text(_scanError!,
                      style: TextStyle(
                          fontSize: 13,
                          color: C.red,
                          fontWeight: FontWeight.w600)),
                ],
                if (l != null) ...[
                  const SizedBox(height: 16),
                  Panel(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(_locText(l),
                            style: const TextStyle(
                                fontSize: 26, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 4),
                        Text(c.selWhName,
                            style: TextStyle(fontSize: 13, color: C.muted)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text('ระบบบันทึกว่ามี ${boxesHere.length} ใบที่นี่',
                      style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          color: C.muted)),
                  const SizedBox(height: 8),
                  if (boxesHere.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                          vertical: 20, horizontal: 4),
                      child: Text('ระบบไม่พบกล่องบันทึกไว้ที่ช่องนี้',
                          style: TextStyle(
                              fontSize: 13, color: C.faint, height: 1.4)),
                    )
                  else
                    Container(
                      decoration: BoxDecoration(
                        color: C.surface,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: C.border),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: List.generate(boxesHere.length, (i) {
                          final b = boxesHere[i];
                          return Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 14, vertical: 12),
                            decoration: BoxDecoration(
                              border: i == boxesHere.length - 1
                                  ? null
                                  : Border(
                                      bottom: BorderSide(color: C.border)),
                            ),
                            child: Row(
                              children: [
                                Icon(Icons.inventory_2_outlined,
                                    size: 18, color: C.muted),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Text(b.tag,
                                          style: const TextStyle(
                                              fontSize: 15,
                                              fontWeight: FontWeight.w700,
                                              fontFamily: 'monospace')),
                                      Text(c.S!.typeName(b.type),
                                          style: TextStyle(
                                              fontSize: 12, color: C.muted)),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          );
                        }),
                      ),
                    ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
