import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:boxtrace_pda/controllers/app_controller.dart';
import 'package:boxtrace_pda/screens/relocate_screen.dart';

import 'app_controller_test.dart' show FakeApi, makeController, box;
import 'floor_exception_screens_test.dart' show scan, fixtureStateWithLocation;

/// Covers the destination step of RelocateScreen ("เลือกตำแหน่งปลายทาง"): it
/// used to be four cascading AddableDropdowns (with a typed "add new
/// location" escape hatch), now it only accepts a scanned shelf barcode —
/// same reasoning as every other scan-only location field in this app: a
/// typed/picked destination is how a box ends up on the shelf the system
/// *thinks* it's on rather than the one the operator is actually standing
/// at.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<AppController> pumpRelocate(WidgetTester tester, FakeApi api) async {
    final c = await makeController(api);
    await tester.pumpWidget(
      ChangeNotifierProvider<AppController>.value(
        value: c,
        child: const MaterialApp(home: Scaffold(body: RelocateScreen())),
      ),
    );
    await tester.pump();
    return c;
  }

  /// Step 1's own pick mechanism is untouched by this change — filter by
  /// typing (or scan, which lands the same way via the RFID trigger path),
  /// then tap the result. Not what this file is testing; just the way in.
  Future<void> pickBox(WidgetTester tester, String tag) async {
    await tester.enterText(find.byType(TextField), tag);
    await tester.pump();
    // find.text() also matches the search field's own EditableText (which
    // now echoes the same string) — widgetWithText scopes to the result
    // tile's InkWell specifically.
    await tester.tap(find.widgetWithText(InkWell, tag).hitTestable());
    await tester.pump();
  }

  testWidgets('destination step has no dropdown — only a scan prompt',
      (tester) async {
    await pumpRelocate(tester, FakeApi()..state = fixtureStateWithLocation());
    await pickBox(tester, 'CRT-01'); // warehouse, per fixtureStateWithLocation

    expect(find.text('เลือกตำแหน่งปลายทาง'), findsOneWidget);
    expect(find.byType(DropdownButtonFormField), findsNothing);
    expect(find.text('ยิงบาร์โค้ดชั้นวางปลายทาง'), findsOneWidget);
  });

  testWidgets('scanning the destination shelf relocates the box there',
      (tester) async {
    final api = FakeApi()..state = fixtureStateWithLocation();
    await pumpRelocate(tester, api);
    await pickBox(tester, 'CRT-01');

    await scan(tester, 'LOC-A99'); // defined, empty, per the fixture
    await tester.pump();

    expect(find.text('A / 9 / 9'), findsOneWidget);
    await tester.tap(find.text('ยืนยันย้ายตำแหน่ง'));
    await tester.pump();
    await tester.pump();

    expect(api.putawayCalls, [
      {
        'tag': 'CRT-01',
        'wh': 'WH-1',
        'zone': 'A',
        'rack': '9',
        'shelf': '9',
        'slot': '',
      }
    ]);
    await tester.pump(const Duration(milliseconds: 3000));
  });

  // An unknown shelf code being rejected (not silently accepted) shares its
  // exact resolution code with LocationInquiryScreen/ReportProblemScreen's
  // "ช่องเก็บเต็ม" path, already covered in floor_exception_screens_test.dart.
}
