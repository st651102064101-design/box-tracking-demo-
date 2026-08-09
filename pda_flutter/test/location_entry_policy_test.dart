import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// A shelf location may only ever enter this app by scanning that shelf's own
/// barcode — see LocationScanField's doc for why. That rule is worth an
/// architectural test rather than only a code review: it is easy to undo by
/// accident (a dropdown "just for this one screen") and the damage is silent,
/// because a mistyped location looks exactly like a correct one until someone
/// goes looking for the box.
void main() {
  final dartFiles = Directory('lib')
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => f.path.endsWith('.dart'))
      .toList();

  test('lib has dart files to check at all', () {
    expect(dartFiles, isNotEmpty,
        reason: 'a passing-because-it-scanned-nothing result proves nothing');
  });

  test('no screen offers a picker for a location field', () {
    final offenders = <String>[];
    for (final f in dartFiles) {
      final src = f.readAsStringSync();
      if (src.contains('LocationDropdown')) {
        offenders.add('${f.path}: LocationDropdown');
      }
    }
    expect(offenders, isEmpty,
        reason: 'locations are scanned, never picked — use LocationScanField');
  });

  test('every screen that writes a location gets it from a scan', () {
    // Screens are where an alternative entry path would appear, so that is
    // what this checks. Non-screen callers (AppController.completePutaway)
    // take the location as a parameter and never source one themselves — they
    // are only as safe as the screen calling them, which is exactly what the
    // rule below pins down.
    final offenders = <String>[];
    for (final f in dartFiles) {
      if (!f.path.contains('/screens/')) continue;
      final src = f.readAsStringSync();
      final writesLocation =
          src.contains('putawayBox(') || src.contains('completePutaway(');
      if (!writesLocation) continue;
      if (!src.contains('LocationScanField')) {
        offenders.add(f.path);
      }
    }
    expect(offenders, isEmpty,
        reason: 'a putaway whose location did not come from a scan defeats '
            'the point of scanning everywhere else');
  });
}
