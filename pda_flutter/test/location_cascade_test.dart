import 'package:flutter_test/flutter_test.dart';
import 'package:boxtrace_pda/models/location.dart';

void main() {
  group('LocationCascade', () {
    // Two warehouses, each with its own Location Master rows and its own
    // `code` namespace — mirrors the real bug: WH-002 having zero rows
    // must never fall back to WH-001's zones/racks/etc.
    final locations = {
      'A-R-01-1-01': const Location(code: 'A-R-01-1-01', wh: 'WH-001', zone: 'A', rack: 'R-01', shelf: '1', slot: '01'),
      'A-R-01-1-02': const Location(code: 'A-R-01-1-02', wh: 'WH-001', zone: 'A', rack: 'R-01', shelf: '1', slot: '02'),
      'B-R-02-1-01': const Location(code: 'B-R-02-1-01', wh: 'WH-001', zone: 'B', rack: 'R-02', shelf: '1', slot: '01'),
      'WH2-A-R-01-1-01': const Location(code: 'WH2-A-R-01-1-01', wh: 'WH-002', zone: 'A', rack: 'R-01', shelf: '1', slot: '01'),
    };
    final cascade = LocationCascade(locations);

    test('zones are scoped per warehouse — an empty warehouse never inherits another\'s zones', () {
      expect(cascade.zones('WH-001'), ['A', 'B']);
      expect(cascade.zones('WH-002'), ['A']);
      expect(cascade.zones('WH-003'), isEmpty);
    });

    test('racks/shelves/slots cascade correctly under a chosen zone', () {
      expect(cascade.racks('WH-001', 'A'), ['R-01']);
      expect(cascade.racks('WH-001', 'B'), ['R-02']);
      expect(cascade.shelves('WH-001', 'A', 'R-01'), ['1']);
      expect(cascade.slots('WH-001', 'A', 'R-01', '1'), ['01', '02']);
    });

    test('a single-option level exposes exactly one deterministic default (.first)', () {
      // This is what _autoFillLocDefaults in box_register_screen.dart relies
      // on: the first cascade level with any options picks .first — so a
      // warehouse with one zone auto-settles onto it without operator input.
      final zones = cascade.zones('WH-002');
      expect(zones, isNotEmpty);
      expect(zones.first, 'A');
      final racks = cascade.racks('WH-002', zones.first);
      expect(racks.first, 'R-01');
    });

    test('a warehouse with zero Location Master rows offers nothing to auto-fill', () {
      expect(cascade.zones('WH-003'), isEmpty);
      expect(cascade.racks('WH-003', 'A'), isEmpty);
    });
  });
}
