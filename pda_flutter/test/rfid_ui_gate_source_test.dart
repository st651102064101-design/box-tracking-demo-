import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Guards that RFID-only chrome stays behind [hasIntegratedRfid] checks so a
/// TC52 build cannot regress into showing locate / settings RFID panels.
void main() {
  test('settings RFID panel is gated on hasIntegratedRfid', () {
    final src = File('lib/screens/settings_screen.dart').readAsStringSync();
    expect(src.contains('if (c.hasIntegratedRfid)'), isTrue);
    expect(src.contains('const _RfidPanel()'), isTrue);
    // Panel must appear inside the capability gate, not as a bare always-on tile.
    final gateIdx = src.indexOf('if (c.hasIntegratedRfid)');
    final panelIdx = src.indexOf('const _RfidPanel()');
    expect(gateIdx, greaterThanOrEqualTo(0));
    expect(panelIdx, greaterThan(gateIdx));
  });

  test('more hub hides locate tile without RFID', () {
    final src = File('lib/screens/more_hub_screen.dart').readAsStringSync();
    expect(src.contains('if (c.hasIntegratedRfid)'), isTrue);
    expect(src.contains("loc.t('ค้นหา/เรดาร์')"), isTrue);
  });

  test('ScanModeToggle collapses to nothing without RFID', () {
    final src = File('lib/widgets/common.dart').readAsStringSync();
    expect(src.contains('if (!c.hasIntegratedRfid)'), isTrue);
    expect(src.contains('return const SizedBox.shrink()'), isTrue);
  });
}
