import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/more_hub_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';

import 'app_controller_test.dart' show FakeApi, makeController;

Future<Widget> _wrap(AppController c) async {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<AppController>.value(value: c),
      ChangeNotifierProvider<LocaleController>.value(
          value: LocaleController(c.prefs)),
    ],
    child: const MaterialApp(home: Scaffold(body: MoreHubScreen())),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('TC52 / barcode-only hides ค้นหา/เรดาร์', (tester) async {
    final c = await makeController(FakeApi());
    c.debugHasIntegratedRfid = false;
    await tester.pumpWidget(await _wrap(c));
    await tester.pump();

    expect(find.text('ค้นหา / ตรวจสอบกล่อง'), findsOneWidget);
    expect(find.text('ตรวจนับ'), findsOneWidget);
    expect(find.text('ค้นหา/เรดาร์'), findsNothing);
  });

  testWidgets('MC3390R still offers ค้นหา/เรดาร์', (tester) async {
    final c = await makeController(FakeApi());
    c.debugHasIntegratedRfid = true;
    await tester.pumpWidget(await _wrap(c));
    await tester.pump();

    expect(find.text('ค้นหา/เรดาร์'), findsOneWidget);
  });
}
