import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/settings_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/services/theme_controller.dart';

import 'app_controller_test.dart' show FakeApi, makeController;

Future<Widget> _wrap(AppController c) async {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<AppController>.value(value: c),
      ChangeNotifierProvider<LocaleController>.value(
          value: LocaleController(c.prefs)),
      ChangeNotifierProvider<ThemeController>.value(
          value: ThemeController(c.prefs)),
    ],
    child: const MaterialApp(home: Scaffold(body: SettingsScreen())),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('TC52 hides every RFID settings surface', (tester) async {
    final c = await makeController(FakeApi());
    c.debugHasIntegratedRfid = false;
    await tester.pumpWidget(await _wrap(c));
    await tester.pump();

    expect(find.textContaining('เครื่องอ่าน RFID'), findsNothing);
    expect(find.text('รับค่า RFID'), findsNothing);
    expect(find.text('เชื่อมต่อใหม่'), findsNothing);
    expect(find.text('เสียงตอนอ่าน RFID'), findsNothing);
    expect(find.textContaining('RFIDAPI3'), findsNothing);
  });

  testWidgets('MC3390R still shows the RFID reader panel', (tester) async {
    final c = await makeController(FakeApi());
    c.debugHasIntegratedRfid = true;
    await tester.pumpWidget(await _wrap(c));
    await tester.pump();

    expect(find.textContaining('เครื่องอ่าน RFID'), findsOneWidget);
  });

  testWidgets('saved TC501 profile shows all RFID settings before connect',
      (tester) async {
    final c = await makeController(FakeApi());
    c.prefs.deviceModel = 'tc501';
    // On a fresh app session the SDK may not have replied yet. The known
    // hardware profile must still expose settings so the operator can retry.
    c.debugHasIntegratedRfid = false;
    await tester.pumpWidget(await _wrap(c));
    await tester.pump();

    expect(find.textContaining('เครื่องอ่าน RFID'), findsOneWidget);
    await tester.drag(find.byType(ListView).first, const Offset(0, -900));
    await tester.pumpAndSettle();
    expect(find.text('รับค่า RFID'), findsOneWidget);
    expect(find.text('ระยะยิงแท็ก'), findsOneWidget);
    expect(find.text('กรองสัญญาณอ่อน (RSSI)'), findsOneWidget);
    expect(find.text('เสียงเมื่อเจอแท็ก RFID'), findsOneWidget);
    expect(find.text('เชื่อมต่อใหม่'), findsOneWidget);
  });
}
