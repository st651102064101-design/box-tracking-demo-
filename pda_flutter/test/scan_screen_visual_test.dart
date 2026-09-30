import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/scan_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/theme.dart';

import 'app_controller_test.dart' show FakeApi, fixtureState, makeController;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('primary action has no painted footer panel', (tester) async {
    final c = await makeController(FakeApi());
    c.goScanOut();
    C.apply(true);
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: ScanScreen())),
    ));

    final footer = find.byKey(const Key('scan-primary-footer'));
    expect(footer, findsOneWidget);
    expect(tester.widget(footer), isA<Padding>());

    C.apply(false);
    c.dispose();
  });

  testWidgets('outbound opens the customer choices on entry', (tester) async {
    final api = FakeApi()..state = fixtureState();
    (api.state['customers'] as Map<String, dynamic>)['CUST-02'] = {
      'id': 'CUST-02',
      'name': 'Second customer',
      'returnDays': 15,
    };
    final c = await makeController(api);
    c.goScanOut();
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: ScanScreen())),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('CUST-02 · Second customer'), findsOneWidget);
    c.dispose();
  });

  testWidgets('outbound asks for confirmation with one customer',
      (tester) async {
    final c = await makeController(FakeApi());
    c.goScanOut();
    expect(c.outCustomer, isEmpty);
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: ScanScreen())),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('CUST-01 · ลูกค้าทดสอบ'), findsOneWidget);
    await tester.tap(find.text('CUST-01 · ลูกค้าทดสอบ'));
    await tester.pump();
    expect(c.outCustomer, 'CUST-01');
    c.dispose();
  });

  testWidgets('customer picker opens when the list arrives after entry',
      (tester) async {
    final api = FakeApi()..state = fixtureState();
    api.state['customers'] = <String, dynamic>{};
    final c = await makeController(api);
    c.goScanOut();
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: ScanScreen())),
    ));
    await tester.pump();
    api.state = fixtureState();
    await c.refresh();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('CUST-01 · ลูกค้าทดสอบ'), findsOneWidget);
    c.dispose();
  });

  testWidgets('successful scan badge text uses theme-readable lime',
      (tester) async {
    final c = await makeController(FakeApi());
    c.goScanOut();
    c.addScan('CRT-01');
    c.setOutCustomer('CUST-01');
    C.apply(true);
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: ScanScreen())),
    ));
    await tester.pump();
    await tester.tap(find.text('ถัดไป'));
    await tester.pump();

    final chip = find.byWidgetPredicate((widget) =>
        widget is Text &&
        widget.textSpan?.toPlainText().contains('CRT-01') == true);
    expect(chip, findsOneWidget);
    final text = tester.widget<Text>(chip);
    expect(text.textSpan?.style?.color, C.limeText);
    expect(text.textSpan?.style?.color, isNot(C.limeDeep));

    C.apply(false);
    c.dispose();
  });
}
