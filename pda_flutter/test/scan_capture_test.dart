import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:boxtrace_pda/widgets/scan_capture.dart';

/// The imager delivers a decoded barcode over the text input connection in one
/// go, which is what [WidgetTester.enterText] does too — so this is the real
/// shape of a scan, not an approximation of one.
Future<void> scan(WidgetTester tester, String code) =>
    tester.enterText(find.byType(TextField), code);

/// A human at a keyboard instead: one character per callback.
Future<void> typeSlowly(WidgetTester tester, String code) async {
  for (var i = 1; i <= code.length; i++) {
    await tester.enterText(find.byType(TextField), code.substring(0, i));
  }
}

void main() {
  Future<List<String>> pump(WidgetTester tester, {bool enabled = true}) async {
    final scans = <String>[];
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: ScanCapture(
          enabled: enabled,
          onScan: scans.add,
          child: const SizedBox.expand(child: Text('state display')),
        ),
      ),
    ));
    await tester.pump();
    return scans;
  }

  testWidgets('the capture field exists and holds focus — an unfocused one '
      'receives nothing and there is no visible box to tap to fix that',
      (tester) async {
    await pump(tester);
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.focusNode!.hasFocus, isTrue);
  });

  testWidgets('no software keyboard can be raised, so nothing can be typed '
      'by hand on the handheld', (tester) async {
    await pump(tester);
    final field = tester.widget<TextField>(find.byType(TextField));
    // The guard against a hand-keyed box id that looks exactly like a scanned
    // one. kIsWeb is false under flutter test.
    expect(field.keyboardType, TextInputType.none);
  });

  testWidgets('a scanned burst resolves at once — no trailing Enter needed',
      (tester) async {
    final scans = await pump(tester);
    await scan(tester, 'CRT-01');
    expect(scans, ['CRT-01']);
  });

  testWidgets('the field is emptied after a scan, so the next one is not '
      'appended to the last', (tester) async {
    final scans = await pump(tester);
    await scan(tester, 'CRT-01');
    await scan(tester, 'CRT-02');
    expect(scans, ['CRT-01', 'CRT-02']);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty);
  });

  testWidgets('character-at-a-time input waits for the input to go quiet',
      (tester) async {
    final scans = await pump(tester);
    await typeSlowly(tester, 'CRT-01');
    expect(scans, isEmpty, reason: 'the burst may not have ended yet');
    await tester.pump(const Duration(milliseconds: 250));
    expect(scans, ['CRT-01']);
  });

  testWidgets('a stray single character is not a barcode', (tester) async {
    final scans = await pump(tester);
    await scan(tester, 'C');
    await tester.pump(const Duration(milliseconds: 250));
    expect(scans, isEmpty);
  });

  testWidgets('disabled captures nothing — a scan mid-submit is dropped',
      (tester) async {
    final scans = await pump(tester, enabled: false);
    await scan(tester, 'CRT-01');
    await tester.pump(const Duration(milliseconds: 250));
    expect(scans, isEmpty);
  });

  testWidgets('focus lost to anything else is taken back', (tester) async {
    final scans = await pump(tester);
    final field = tester.widget<TextField>(find.byType(TextField));
    field.focusNode!.unfocus();
    await tester.pump();
    await tester.pump();
    expect(field.focusNode!.hasFocus, isTrue);
    // And it is still live, which is the point of reclaiming it.
    await scan(tester, 'CRT-01');
    expect(scans, ['CRT-01']);
  });
}
