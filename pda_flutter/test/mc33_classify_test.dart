import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/handheld_profile.dart';

void main() {
  test('a plain Zebra MC33 is classified as the MC3390R', () {
    final p = HandheldProfile.classify(
      model: 'MC33',
      manufacturer: 'Zebra Technologies',
      brand: 'Zebra',
      androidRelease: '8.1.0',
    );
    expect(p.id, 'mc3390r');
    expect(p.presenceName, 'Zebra MC3390R');
  });
}
