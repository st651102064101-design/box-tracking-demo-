import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/track_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/services/prefs.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';

import 'app_controller_test.dart' show FakeApi, box, fixtureEmployees;

Map<String, dynamic> _stateWithManyBoxes(int count) => {
      'boxes': {
        for (var i = 1; i <= count; i++)
          'BOX-${i.toString().padLeft(3, '0')}': box(
            'BOX-${i.toString().padLeft(3, '0')}',
            i.isEven ? 'out' : 'warehouse',
            lastSeenAt: '2026-09-23T10:${(i % 60).toString().padLeft(2, '0')}:00',
          ),
      },
      'customers': <String, dynamic>{},
      'boxtypes': {
        'BT-CRT': {'id': 'BT-CRT', 'name': 'ลังพลาสติก 60L'}
      },
      'warehouses': {
        'WH-1': {
          'id': 'WH-1',
          'name': 'คลัง 1',
          'gates': [1],
          'gateTypes': {'1': 'both'},
        }
      },
      'gates': {'1': 'WH-1'},
      'employees': fixtureEmployees(),
      'events': <dynamic>[],
      'cfg': {'agingDays': 15},
    };

Future<AppController> _controllerWith(int boxCount) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await Prefs.load();
  final api = FakeApi()..state = _stateWithManyBoxes(boxCount);
  final c = AppController(api: api, prefs: prefs, rfid: RfidService());
  await c.refresh();
  c.wh = 'WH-1';
  c.gate = '1';
  prefs.deviceWh = 'WH-1';
  prefs.deviceGate = '1';
  prefs.deviceConfigured = true;
  prefs.token = 'device-token';
  c.debugHasIntegratedRfid = false;
  c.emp = c.employees.firstWhere((e) => e.id == 'EMP-0001');
  return c;
}

Future<Widget> _wrap(AppController c) async {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<AppController>.value(value: c),
      ChangeNotifierProvider<LocaleController>.value(
          value: LocaleController(c.prefs)),
    ],
    child: const MaterialApp(home: Scaffold(body: TrackScreen())),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('TC52 track screen matches the scan-or-type layout',
      (tester) async {
    final c = await _controllerWith(5);
    await tester.pumpWidget(await _wrap(c));
    await tester.pumpAndSettle();

    expect(find.text('กดปุ่ม SCANNER ที่เครื่อง'), findsOneWidget);
    expect(find.text('เพื่อยิงบาร์โค้ดได้'), findsOneWidget);
    expect(find.text('หรือ'), findsOneWidget);
    expect(find.text('พิมพ์รหัสกล่อง'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    expect(find.text('ค้นหา'), findsNothing);
    expect(find.text('ประวัติการสแกนล่าสุด'), findsOneWidget);
    expect(find.text('บาร์โค้ด · Zebra DataWedge SDK'), findsNothing);
    expect(find.byType(GridView), findsNothing);
  });

  testWidgets('พิมพ์รหัสกล่อง reveals the input and search button',
      (tester) async {
    final c = await _controllerWith(5);
    await tester.pumpWidget(await _wrap(c));
    await tester.pumpAndSettle();

    expect(find.byType(TextField), findsNothing);
    await tester.tap(find.text('พิมพ์รหัสกล่อง'));
    await tester.pump();
    await tester.pump();

    expect(find.byType(TextField), findsOneWidget);
    expect(find.text('ค้นหา'), findsOneWidget);
    expect(
        tester.widget<TextField>(find.byType(TextField)).focusNode?.hasFocus,
        isTrue);
  });

  testWidgets('typing a query rebuilds the screen with live suggestions',
      (tester) async {
    final c = await _controllerWith(5);
    await tester.pumpWidget(await _wrap(c));
    await tester.pumpAndSettle();

    await tester.tap(find.text('พิมพ์รหัสกล่อง'));
    await tester.pump();
    await tester.pump();

    expect(find.text('พบ 5 กล่อง'), findsNothing, reason: 'nothing typed yet');
    await tester.enterText(find.byType(TextField), 'BOX');
    await tester.pump();

    expect(find.text('พบ 5 กล่อง'), findsOneWidget);
    expect(find.text('BOX-001'), findsOneWidget);
    expect(find.byType(GridView), findsNothing);
  });

  testWidgets('a search matching 100 boxes shows all 100, uncapped',
      (tester) async {
    final c = await _controllerWith(100);
    await tester.pumpWidget(await _wrap(c));
    await tester.pumpAndSettle();

    await tester.tap(find.text('พิมพ์รหัสกล่อง'));
    await tester.pump();
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'BOX');
    await tester.pump();

    expect(c.trackSuggestions, hasLength(100),
        reason: 'the model itself must not cap the match list');
    expect(find.text('พบ 100 กล่อง'), findsOneWidget);
    expect(find.text('BOX-001'), findsOneWidget);
    expect(find.text('BOX-100'), findsOneWidget);
  });
}
