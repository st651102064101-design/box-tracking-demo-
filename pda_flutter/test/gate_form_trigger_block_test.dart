import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:boxtrace_pda/controllers/app_controller.dart';
import 'package:boxtrace_pda/screens/scan_screen.dart';
import 'package:boxtrace_pda/services/i18n.dart';

import 'app_controller_test.dart' show FakeApi, makeController, fillVehicle;

/// Covers AppController.gateFormStep: while ScanScreen is on its
/// customer/vehicle form (ลูกค้าปลายทาง/ทะเบียนรถ/คนขับ/ประเภทรถ), a trigger
/// pull must be refused — not silently, and not by quietly starting an RFID
/// sweep behind a form nobody meant to scan into. See
/// AppController._onReaderTrigger's `screen == Screen.scan && gateFormStep`
/// block and ScanScreen._setOnScanStep, the one place the flag flips.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<AppController> pumpGateIn(WidgetTester tester) async {
    final c = await makeController(FakeApi());
    c.goScanIn();
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AppController>.value(value: c),
          ChangeNotifierProvider<LocaleController>.value(
              value: LocaleController(c.prefs)),
        ],
        child: const MaterialApp(home: Scaffold(body: ScanScreen())),
      ),
    );
    // Not pumpAndSettle: the putaway step's pulse animation (see
    // ScanScreen._pulse) repeats forever by design and would never settle.
    await tester.pump();
    return c;
  }

  testWidgets('opens on the form step with the trigger blocked',
      (tester) async {
    final c = await pumpGateIn(tester);
    expect(c.gateFormStep, isTrue);
    // "ถัดไป" — the step's own primary button label.
    expect(find.text('ถัดไป'), findsOneWidget);
  });

  // AppController._onReaderTrigger's actual toast branch isn't covered here:
  // RfidService's trigger stream has no test seam (the platform channel that
  // feeds it doesn't run under `flutter test`), which is a pre-existing gap
  // shared by every other branch in that dispatcher (putawayTask,
  // boxRegisterRfidStep — neither has a trigger test either). What's
  // covered below is the part that's actually reachable and is where a
  // regression would really happen: gateFormStep itself flipping true/false
  // in lockstep with the step ScanScreen is on.

  testWidgets('moving to the scan step clears gateFormStep', (tester) async {
    final c = await pumpGateIn(tester);
    fillVehicle(c);
    c.setOutCustomer(''); // gate-in path doesn't need a customer
    expect(c.gateFormStep, isTrue);

    await tester.tap(find.text('ถัดไป'));
    await tester.pump();

    expect(c.gateFormStep, isFalse,
        reason: 'the scan step is up — the trigger should work now');
  });

  testWidgets('"แก้ไขข้อมูลลูกค้า/รถ" sets gateFormStep back to true',
      (tester) async {
    final c = await pumpGateIn(tester);
    fillVehicle(c);
    await tester.tap(find.text('ถัดไป'));
    await tester.pump();
    expect(c.gateFormStep, isFalse);

    await tester.tap(find.text('แก้ไขข้อมูลลูกค้า/รถ'));
    await tester.pump();

    expect(c.gateFormStep, isTrue,
        reason: 'back on the form — the trigger must be blocked again');
  });
}
