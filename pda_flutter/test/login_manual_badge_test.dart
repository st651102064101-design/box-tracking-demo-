import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/login_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/widgets/common.dart';
import 'package:smarttrace_pda/widgets/scan_capture.dart';

import 'app_controller_test.dart' show FakeApi, makeController;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('online label hides after five visible seconds and resets',
      (tester) async {
    final c = await makeController(FakeApi());
    c.emp = null;
    c.screen = Screen.login;
    expect(c.onlineDisplay, isTrue);
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: LoginScreen())),
    ));

    expect(find.text('ออนไลน์'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 4999));
    expect(find.text('ออนไลน์'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1));
    expect(find.text('ออนไลน์'), findsNothing);
    expect(find.byType(OnlineChip), findsOneWidget);

    c.onlineChipTap();
    await tester.pump();
    expect(find.text('ออฟไลน์'), findsOneWidget);
    c.onlineChipTap();
    await tester.pump();
    expect(find.text('ออนไลน์'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    expect(find.text('ออนไลน์'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    c.dispose();
  });

  testWidgets('badge prompt becomes input with SVG submit at a complete code',
      (tester) async {
    final c = await makeController(FakeApi());
    c.emp = null;
    c.screen = Screen.login;
    c.prefs.skipPin('EMP-0001');
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: LoginScreen())),
    ));

    expect(find.byKey(const Key('manual-employee-code-input')), findsNothing);
    expect(tester.widget<ScanCapture>(find.byType(ScanCapture)).enabled, isTrue);

    await tester.tap(find.byKey(const Key('open-employee-code-input')));
    await tester.pump();
    final input = find.byKey(const Key('manual-employee-code-input'));
    expect(input, findsOneWidget);
    expect(tester.widget<TextField>(input).focusNode?.hasFocus, isTrue);
    expect(tester.widget<ScanCapture>(find.byType(ScanCapture)).enabled, isFalse);

    await tester.enterText(input, 'EMP-000');
    await tester.pump();
    expect(find.byKey(const Key('submit-employee-code')), findsNothing);

    await tester.enterText(input, 'EMP-0001');
    await tester.pump();
    expect(find.byKey(const Key('submit-employee-code')), findsOneWidget);

    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(c.emp, isNull,
        reason: 'typing or keyboard Done must not sign in before SVG tap');

    await tester.tap(find.byKey(const Key('submit-employee-code')));
    await tester.pump();
    expect(c.emp?.id, 'EMP-0001');
    expect(c.screen, Screen.home);
    c.dispose();
  });

  testWidgets('says to just pull the trigger; typing is the named alternative',
      (tester) async {
    final c = await makeController(FakeApi());
    c.emp = null;
    c.screen = Screen.login;
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: LoginScreen())),
    ));

    expect(find.text('เหนี่ยวไกยิงบัตรได้เลย'), findsOneWidget);
    expect(find.text('พิมพ์รหัสพนักงานแทน'), findsOneWidget);
    expect(find.text('ยิงบัตรพนักงาน'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    c.dispose();
  });

  group('leaving the code field puts the badge prompt back', () {
    Future<AppController> open(WidgetTester tester) async {
      final c = await makeController(FakeApi());
      c.emp = null;
      c.screen = Screen.login;
      await tester.pumpWidget(MultiProvider(
        providers: [
          ChangeNotifierProvider<AppController>.value(value: c),
          ChangeNotifierProvider<LocaleController>.value(
              value: LocaleController(c.prefs)),
        ],
        child: const MaterialApp(home: Scaffold(body: LoginScreen())),
      ));
      await tester.tap(find.byKey(const Key('open-employee-code-input')));
      await tester.pump();
      await tester.enterText(
          find.byKey(const Key('manual-employee-code-input')), 'EMP');
      await tester.pump();
      return c;
    }

    void expectClosed(WidgetTester tester) {
      expect(find.byKey(const Key('manual-employee-code-input')), findsNothing);
      // No blinking cursor anywhere, and the trigger reads badges again.
      expect(find.byType(EditableText), findsOneWidget,
          reason: 'only the hidden scan capture is left');
      expect(tester.widget<ScanCapture>(find.byType(ScanCapture)).enabled,
          isTrue);
    }

    testWidgets('on a tap elsewhere', (tester) async {
      final c = await open(tester);
      await tester.tap(find.text('เหนี่ยวไกยิงบัตรได้เลย'));
      await tester.pump();
      expectClosed(tester);

      await tester.tap(find.byKey(const Key('open-employee-code-input')));
      await tester.pump();
      final input = tester.widget<TextField>(
          find.byKey(const Key('manual-employee-code-input')));
      expect(input.controller?.text, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      c.dispose();
    });

    testWidgets('when the keyboard is dismissed', (tester) async {
      final c = await open(tester);
      tester.view.viewInsets = const FakeViewPadding(bottom: 600);
      addTearDown(tester.view.reset);
      await tester.pump();
      expect(find.byKey(const Key('manual-employee-code-input')), findsOneWidget);

      tester.view.viewInsets = FakeViewPadding.zero;
      await tester.pump();
      await tester.pump();
      expectClosed(tester);
      await tester.pumpWidget(const SizedBox.shrink());
      c.dispose();
    });
  });
}
