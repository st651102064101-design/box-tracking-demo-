import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:boxtrace_pda/controllers/app_controller.dart';
import 'package:boxtrace_pda/screens/device_setup_screen.dart';
import 'package:boxtrace_pda/services/i18n.dart';
import 'package:boxtrace_pda/services/theme_controller.dart';

import 'app_controller_test.dart' show FakeApi, makeController;

/// The server address is the one value on this device that used to be typed
/// on a handheld keypad. It is now scanned from the QR the web app prints
/// (ตั้งค่า → เชื่อมต่อ PDA), so these tests pin the two things that make the
/// swap worth anything: the address entry starts as a scan target rather than
/// a text box, and a scanned payload lands in the fields it claims to fill.
Future<Widget> _wrap(AppController c) async {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<AppController>.value(value: c),
      ChangeNotifierProvider<LocaleController>.value(
          value: LocaleController(c.prefs)),
      ChangeNotifierProvider<ThemeController>.value(
          value: ThemeController(c.prefs)),
    ],
    child: const MaterialApp(
        home: Scaffold(body: DeviceSetupScreen())),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the server address is a scan target, not a text field',
      (tester) async {
    final c = await makeController(FakeApi());
    c.prefs.baseUrl = '';
    await tester.pumpWidget(await _wrap(c));
    await tester.pump();

    expect(find.text('สแกน QR เพื่อเชื่อมต่อ'), findsOneWidget);
    // No URL box anywhere until someone deliberately asks for one.
    expect(find.widgetWithText(TextField, 'http://192.168.1.10:4000'),
        findsNothing);

    await tester.tap(find.text('ไม่มี QR — พิมพ์ที่อยู่เอง'));
    await tester.pump();
    expect(find.byType(TextField), findsWidgets);
  });

  testWidgets('scanning a connection QR fills the address and the account',
      (tester) async {
    final c = await makeController(FakeApi());
    c.prefs.baseUrl = '';
    await tester.pumpWidget(await _wrap(c));
    await tester.pump();

    await tester.tap(find.text('สแกน QR เพื่อเชื่อมต่อ'));
    // pumpAndSettle never returns here: ScanCapture re-arms its focus every
    // frame by design, so the sheet is pumped by hand instead.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('ยิง QR เชื่อมต่อระบบ'), findsOneWidget);

    // The imager delivers into the sheet's hidden ScanCapture field exactly
    // as it does on every other scan screen.
    await tester.enterText(find.byType(TextField).first,
        'BTCFG1:{"url":"http://10.0.0.5:4000","user":"pda-07"}');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('http://10.0.0.5:4000'), findsOneWidget);
    expect(find.text('จาก QR · แตะเพื่อสแกนใหม่'), findsOneWidget);
    // The account came with the QR, so its collapsed section is opened to
    // show what was just changed rather than changing it silently.
    expect(find.widgetWithText(TextField, 'pda-07'), findsOneWidget);
  });

  testWidgets('a box barcode scanned by mistake is rejected, not accepted',
      (tester) async {
    final c = await makeController(FakeApi());
    c.prefs.baseUrl = '';
    await tester.pumpWidget(await _wrap(c));
    await tester.pump();

    await tester.tap(find.text('สแกน QR เพื่อเชื่อมต่อ'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    await tester.enterText(find.byType(TextField).first, 'CRT-01');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    // Still on the sheet, and told why — a silent no-op is indistinguishable
    // from a dead imager.
    expect(find.textContaining('ไม่ใช่ QR เชื่อมต่อระบบ'), findsOneWidget);
  });
}
