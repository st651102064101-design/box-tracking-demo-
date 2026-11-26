/// See docs/superpowers/specs/2026-11-26-pda-receive-ship-design.md
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/home_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/widgets/system_picker.dart';

import 'app_controller_test.dart' show FakeApi, makeController;

Future<AppController> _controller() async {
  final c = await makeController(FakeApi());
  c.confirmPost('WH-1', 3);
  return c;
}

Future<void> _show(WidgetTester tester, AppController c, Widget child) async {
  await tester.pumpWidget(MultiProvider(
    providers: [
      ChangeNotifierProvider<AppController>.value(value: c),
      ChangeNotifierProvider<LocaleController>.value(
          value: LocaleController(c.prefs)),
    ],
    child: MaterialApp(
        home: Scaffold(
            body: Consumer<AppController>(builder: (_, __, ___) => child))),
  ));
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a terminal starts with every feature and remembers the choice',
      () async {
    final c = await _controller();
    expect(c.receiveShipOnly, isFalse);
    c.setReceiveShipOnly(true);
    expect(c.prefs.receiveShipOnly, isTrue);
    c.dispose();
  });

  test('receive-and-ship never opens the other menus', () async {
    final c = await _controller();
    c.setReceiveShipOnly(true);
    c.screen = Screen.home;
    c.goMoreHub();
    expect(c.screen, Screen.home);
    for (final s in [
      Screen.track,
      Screen.cycleCount,
      Screen.holdRelease,
      Screen.locationInquiry,
      Screen.transfer,
    ]) {
      c.go(s);
      expect(c.screen, Screen.home, reason: '$s');
    }
    c.go(Screen.settings);
    expect(c.screen, Screen.settings);
    c.dispose();
  });

  testWidgets('home offers only the two jobs', (tester) async {
    final c = await _controller();
    c.setReceiveShipOnly(true);
    await _show(tester, c, const HomeScreen());

    expect(find.text('รับเข้า'), findsOneWidget);
    expect(find.text('จ่ายออก'), findsOneWidget);
    expect(find.text('เมนูอื่นๆ'), findsNothing);
    expect(find.text('ในคลัง'), findsNothing);
    c.dispose();
  });

  testWidgets('the full system keeps its home as before', (tester) async {
    final c = await _controller();
    await _show(tester, c, const HomeScreen());

    expect(find.text('รับคืน'), findsOneWidget);
    expect(find.text('เมนูอื่นๆ'), findsOneWidget);
    c.dispose();
  });

  testWidgets('the picker switches between the two systems', (tester) async {
    final c = await _controller();
    await _show(tester, c, const SystemPicker());

    await tester.tap(find.text('รับ-ส่ง'));
    await tester.pump();
    expect(c.receiveShipOnly, isTrue);
    await tester.tap(find.text('ครบทุกฟีเจอร์'));
    await tester.pump();
    expect(c.receiveShipOnly, isFalse);
    c.dispose();
  });
}
