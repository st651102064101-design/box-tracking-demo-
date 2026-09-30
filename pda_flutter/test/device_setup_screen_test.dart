import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/device_setup_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/services/theme_controller.dart';

import 'app_controller_test.dart' show FakeApi, makeController;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> expectDetectedDeviceProfile(
    WidgetTester tester, {
    required String model,
    required bool hasRfid,
  }) async {
    const channel = MethodChannel('smarttrace/rfid');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'deviceInfo') {
        return {
          'model': model,
          'manufacturer': 'Zebra Technologies',
          'brand': 'Zebra',
          'androidRelease': '15',
        };
      }
      return null;
    });
    final c = await makeController(FakeApi());
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AppController>.value(value: c),
          ChangeNotifierProvider<LocaleController>.value(
              value: LocaleController(c.prefs)),
          ChangeNotifierProvider<ThemeController>.value(
              value: ThemeController(c.prefs)),
        ],
        child: const MaterialApp(home: Scaffold(body: DeviceSetupScreen())),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    if (hasRfid) {
      expect(
        find.text('ใช้ Zebra SDK ได้: สแกนบาร์โค้ด, อ่าน/เขียน RFID และค้นหาแท็ก'),
        findsOneWidget,
      );
    } else {
      expect(find.textContaining('RFID ในตัวเครื่องใช้ไม่ได้'), findsOneWidget);
    }
    c.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  }

  testWidgets('TC501 profile enables integrated RFID', (tester) async {
    await expectDetectedDeviceProfile(tester, model: 'TC501', hasRfid: true);
  });

  testWidgets('TC52 profile stays barcode-only', (tester) async {
    await expectDetectedDeviceProfile(tester, model: 'TC52', hasRfid: false);
  });

  testWidgets('device setup never asks for a username or password',
      (tester) async {
    final c = await makeController(FakeApi());
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AppController>.value(value: c),
          ChangeNotifierProvider<LocaleController>.value(
              value: LocaleController(c.prefs)),
          ChangeNotifierProvider<ThemeController>.value(
              value: ThemeController(c.prefs)),
        ],
        child: const MaterialApp(home: Scaffold(body: DeviceSetupScreen())),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('บัญชีประจำเครื่อง'), findsNothing);
    expect(find.text('ชื่อบัญชีเครื่อง เช่น pda-01'), findsNothing);
    expect(find.text('รหัสผ่าน (เว้นว่าง = ไม่เปลี่ยน)'), findsNothing);
    expect(find.text('ที่อยู่เซิร์ฟเวอร์'), findsOneWidget);
    final scannerField = tester.widget<TextField>(
      find.byType(TextField, skipOffstage: false),
    );
    expect(scannerField.keyboardType, TextInputType.none,
        reason: 'the focused scanner target must not open the soft keyboard');
  });
}
