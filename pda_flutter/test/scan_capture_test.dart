import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:boxtrace_pda/widgets/scan_capture.dart';

/// Types [code] the way the handheld's keyboard-wedge imager does: one key
/// event per character, no widget focused but ScanCapture's own node.
Future<void> wedge(WidgetTester tester, String code) async {
  for (final ch in code.split('')) {
    await simulateKeyDownEvent(_keyFor(ch), character: ch);
    await simulateKeyUpEvent(_keyFor(ch));
  }
}

LogicalKeyboardKey _keyFor(String ch) {
  const digits = {
    '0': LogicalKeyboardKey.digit0,
    '1': LogicalKeyboardKey.digit1,
    '2': LogicalKeyboardKey.digit2,
    '3': LogicalKeyboardKey.digit3,
  };
  return digits[ch] ?? LogicalKeyboardKey.keyA;
}

void main() {
  Future<List<String>> pump(WidgetTester tester,
      {bool enabled = true}) async {
    final scans = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: ScanCapture(
        enabled: enabled,
        onScan: scans.add,
        child: const SizedBox.expand(),
      ),
    ));
    await tester.pump();
    return scans;
  }

  testWidgets('a wedge burst arrives as one scan once the keys go quiet',
      (tester) async {
    final scans = await pump(tester);
    await wedge(tester, 'A1A2');
    // Nothing yet — the burst has to be seen to have ended first.
    expect(scans, isEmpty);
    await tester.pump(const Duration(milliseconds: 200));
    expect(scans, ['A1A2']);
  });

  testWidgets('a trailing Enter ends the scan immediately', (tester) async {
    final scans = await pump(tester);
    await wedge(tester, 'A1A2');
    await simulateKeyDownEvent(LogicalKeyboardKey.enter);
    await simulateKeyUpEvent(LogicalKeyboardKey.enter);
    // No timer had to expire for this one.
    expect(scans, ['A1A2']);
    // …and the idle fallback must not then fire a second, empty scan.
    await tester.pump(const Duration(milliseconds: 200));
    expect(scans, ['A1A2']);
  });

  testWidgets('a stray single keypress is not a barcode', (tester) async {
    final scans = await pump(tester);
    await wedge(tester, 'A');
    await tester.pump(const Duration(milliseconds: 200));
    expect(scans, isEmpty);
  });

  testWidgets('disabled captures nothing — a scan mid-submit is dropped',
      (tester) async {
    final scans = await pump(tester, enabled: false);
    await wedge(tester, 'A1A2');
    await tester.pump(const Duration(milliseconds: 200));
    expect(scans, isEmpty);
  });

  testWidgets('back-to-back bursts are two scans, not one run-on code',
      (tester) async {
    final scans = await pump(tester);
    await wedge(tester, 'A1A2');
    await tester.pump(const Duration(milliseconds: 200));
    await wedge(tester, 'A3A3');
    await tester.pump(const Duration(milliseconds: 200));
    expect(scans, ['A1A2', 'A3A3']);
  });
}
