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
}
