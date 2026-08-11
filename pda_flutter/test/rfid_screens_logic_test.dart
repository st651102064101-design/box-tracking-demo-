import 'package:flutter_test/flutter_test.dart';

import 'package:smarttrace_pda/models/state_snapshot.dart';

/// Covers the pure logic behind the RFID-screen fixes in this change. The
/// screens themselves need a live reader plus a mocked platform channel to
/// drive end-to-end, which this project has no harness for yet — what is
/// testable without one is the resolution these screens now depend on.
void main() {
  group('EPC → box resolution (damage report / relocate / cycle count)', () {
    // Damage reporting, relocation and cycle counting all changed from showing
    // raw EPCs to showing the box a tag belongs to. All three go through
    // StateSnapshot.tagForCode, so this is the shared contract.
    final snap = StateSnapshot.fromJson({
      'boxes': {
        'BOX-011': {
          'tag': 'BOX-011',
          'type': 'BT-001',
          'status': 'warehouse',
          'rfidEpc': 'E2004707A1B2C3D4',
          'location': {'wh': 'WH-001', 'zone': 'A', 'rack': 'R-01'},
        },
        'BOX-012': {
          'tag': 'BOX-012',
          'type': 'BT-002',
          'status': 'warehouse',
          'rfidTid': 'E2801190TID0001',
          'location': {'wh': 'WH-001', 'zone': 'B', 'rack': 'R-02'},
        },
      },
      'boxtypes': {
        'BT-001': {'name': 'ลังพลาสติก'},
        'BT-002': {'name': 'ลังไม้'},
      },
    });

    test('an EPC resolves to its box tag', () {
      expect(snap.tagForCode('E2004707A1B2C3D4'), 'BOX-011');
    });

    test('resolution is case-insensitive — readers differ on hex casing', () {
      expect(snap.tagForCode('e2004707a1b2c3d4'), 'BOX-011');
    });

    test('a TID resolves too, not just an EPC', () {
      expect(snap.tagForCode('E2801190TID0001'), 'BOX-012');
    });

    test('an unknown tag resolves to null so the UI can fall back to the raw EPC', () {
      expect(snap.tagForCode('DEADBEEFDEADBEEF'), isNull);
    });

    test('the resolved box carries the type name shown under the box id', () {
      final tag = snap.tagForCode('E2004707A1B2C3D4')!;
      expect(snap.typeName(snap.box(tag)?.type), 'ลังพลาสติก');
    });
  });

  group('cycle count variance', () {
    // Mirrors CycleCountScreen's expected/seen comparison: the screen is
    // read-only, so this arithmetic is the whole of what it reports.
    final snap = StateSnapshot.fromJson({
      'boxes': {
        'A1': {
          'tag': 'A1',
          'status': 'warehouse',
          'location': {'wh': 'WH-001', 'zone': 'A', 'rack': 'R-01'},
        },
        'A2': {
          'tag': 'A2',
          'status': 'warehouse',
          'location': {'wh': 'WH-001', 'zone': 'A', 'rack': 'R-01'},
        },
        'B1': {
          'tag': 'B1',
          'status': 'warehouse',
          'location': {'wh': 'WH-001', 'zone': 'B', 'rack': 'R-02'},
        },
        'OUT1': {'tag': 'OUT1', 'status': 'out', 'location': {}},
      },
      'boxtypes': {},
    });

    List<String> expectedIn(String wh, String? zone) => snap.boxes
        .where((b) =>
            (b.status == 'warehouse' || b.status == 'hold') &&
            (b.location['wh'] ?? '') == wh &&
            (zone == null || (b.location['zone'] ?? '') == zone))
        .map((b) => b.tag)
        .toList()
      ..sort();

    test('scope is limited to the selected zone', () {
      expect(expectedIn('WH-001', 'A'), ['A1', 'A2']);
      expect(expectedIn('WH-001', 'B'), ['B1']);
    });

    test('a box that is out with a customer is never expected on a shelf', () {
      expect(expectedIn('WH-001', null), ['A1', 'A2', 'B1']);
    });

    test('missing = expected minus seen; unexpected = seen minus expected', () {
      final expected = expectedIn('WH-001', 'A').toSet();
      // Swept A1 (correct), missed A2, and picked up B1 which belongs in zone B.
      final seen = {'A1', 'B1'};
      expect(expected.difference(seen), {'A2'}); // ขาด
      expect(seen.difference(expected), {'B1'}); // เกิน
      expect(expected.intersection(seen), {'A1'}); // ครบ
    });
  });
}
