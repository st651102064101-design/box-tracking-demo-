import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Which screens are allowed to hold a typable field, and why.
///
/// The rule is not "no text fields anywhere" — it is that a code identifying a
/// box the operator is *holding* must come from the imager, because a
/// hand-keyed one is indistinguishable from a scanned one and wrong in ways
/// nobody notices until the box is missing. A field for finding a box the
/// operator cannot see is a different thing entirely, and stays.
void main() {
  /// Screens whose only box-code entry is a scan. A TextField appearing in one
  /// of these is the regression this guards against.
  const scanOnly = [
    'lib/screens/cycle_count_screen.dart',
    'lib/screens/rfid_register_screen.dart',
    'lib/screens/rfid_input_screen.dart',
  ];

  /// Screens that keep a field on purpose, with the reason. Listed rather than
  /// merely un-checked so that removing one is a deliberate edit to this list
  /// and not an oversight.
  const keepsAField = {
    'lib/screens/track_screen.dart':
        'search — the box is not in hand, that is why you are looking it up',
    'lib/screens/rfid_locate_screen.dart':
        'picks the target box to go and find, which by definition is not here',
    'lib/screens/transfer_screen.dart':
        'the list-picker filter, for a box whose label will not scan',
    'lib/screens/box_register_screen.dart':
        'a brand-new box has no sticker yet, so its code must be typed once',
    'lib/screens/login_screen.dart':
        'a damaged badge must not strand someone at the gate',
    'lib/screens/device_setup_screen.dart':
        'server url and credentials — not a box code at all',
    'lib/screens/scan_screen.dart':
        'plate and driver on the vehicle form — nothing there is a box code, '
            'and the scan step itself has had no field since ScanCapture',
  };

  test('scan-only screens have no typable field at all', () {
    final offenders = <String>[];
    for (final path in scanOnly) {
      final src = File(path).readAsStringSync();
      if (src.contains('TextField(')) offenders.add(path);
      // ScanCapture is how they take a barcode instead.
      if (!src.contains('ScanCapture(')) {
        offenders.add('$path (no ScanCapture — how does it scan?)');
      }
    }
    expect(offenders, isEmpty,
        reason: 'a hand-keyed box code looks exactly like a scanned one');
  });

  test('every screen with a text field is one we decided to keep', () {
    final undeclared = <String>[];
    for (final f in Directory('lib/screens').listSync().whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      if (!f.readAsStringSync().contains('TextField(')) continue;
      if (keepsAField.containsKey(f.path)) continue;
      undeclared.add(f.path);
    }
    expect(undeclared, isEmpty,
        reason: 'a new typable field needs a reason recorded in keepsAField, '
            'or it should be a ScanCapture');
  });

  test('the scan-only list is actually checking files that exist', () {
    for (final path in [...scanOnly, ...keepsAField.keys]) {
      expect(File(path).existsSync(), isTrue, reason: '$path was moved?');
    }
  });
}
