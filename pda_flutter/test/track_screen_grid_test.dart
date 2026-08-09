import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:boxtrace_pda/controllers/app_controller.dart';
import 'package:boxtrace_pda/screens/track_screen.dart';
import 'package:boxtrace_pda/services/i18n.dart';
import 'package:boxtrace_pda/services/prefs.dart';
import 'package:boxtrace_pda/services/rfid_service.dart';

import 'app_controller_test.dart' show FakeApi, box, fixtureEmployees;

/// Covers the grid rewrite of TrackScreen._suggestions: a search that
/// matches a hundred-plus boxes has to actually show all of them (no silent
/// cap), laid out as a grid, not a scrolling wall of single-column rows.
/// Also exercises AppController.onTrackChanged, which was missing
/// notifyListeners() entirely — the live-typeahead suggestions this test
/// depends on had never actually rebuilt the screen on a keystroke before
/// that fix.

/// [count] boxes, all matching the query "BOX" — the scenario from the
/// request ("สมมติยิงเจอะ 100 ก็แสดงไปเลย 100").
Map<String, dynamic> _stateWithManyBoxes(int count) => {
      'boxes': {
        for (var i = 1; i <= count; i++)
          'BOX-${i.toString().padLeft(3, '0')}': box('BOX-${i.toString().padLeft(3, '0')}', 'warehouse'),
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
  c.emp = c.employees.firstWhere((e) => e.id == 'EMP-0001');
  return c;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('typing a query rebuilds the screen with live suggestions', (tester) async {
    final c = await _controllerWith(5);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AppController>.value(value: c),
          ChangeNotifierProvider<LocaleController>.value(
              value: LocaleController(c.prefs)),
        ],
        child: const MaterialApp(home: Scaffold(body: TrackScreen())),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('พบ 5 กล่อง'), findsNothing, reason: 'nothing typed yet');
    await tester.enterText(find.byType(TextField), 'BOX');
    await tester.pump(); // onTrackChanged -> notifyListeners -> rebuild

    expect(find.text('พบ 5 กล่อง'), findsOneWidget);
    expect(find.byType(GridView), findsOneWidget);
  });

  testWidgets('a search matching 100 boxes shows all 100 as grid cards, uncapped', (tester) async {
    final c = await _controllerWith(100);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AppController>.value(value: c),
          ChangeNotifierProvider<LocaleController>.value(
              value: LocaleController(c.prefs)),
        ],
        child: const MaterialApp(home: Scaffold(body: TrackScreen())),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'BOX');
    await tester.pump();

    expect(c.trackSuggestions, hasLength(100), reason: 'the model itself must not cap the match list');
    expect(find.text('พบ 100 กล่อง'), findsOneWidget);

    final grid = tester.widget<GridView>(find.byType(GridView));
    expect(grid.childrenDelegate.estimatedChildCount, 100,
        reason: 'every match must reach the grid — no silent truncation');

    final delegate = grid.gridDelegate as SliverGridDelegateWithFixedCrossAxisCount;
    expect(delegate.crossAxisCount, inInclusiveRange(3, 10),
        reason: 'column count must stay in the 3-10 range requested — never crushed, never sparse');
  });

  testWidgets('column count adapts to width but never drops below 3 or above 10', (tester) async {
    final c = await _controllerWith(30);
    await tester.binding.setSurfaceSize(const Size(320, 640)); // a narrow handheld
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AppController>.value(value: c),
          ChangeNotifierProvider<LocaleController>.value(
              value: LocaleController(c.prefs)),
        ],
        child: const MaterialApp(home: Scaffold(body: TrackScreen())),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'BOX');
    await tester.pump();

    final delegate = tester
        .widget<GridView>(find.byType(GridView))
        .gridDelegate as SliverGridDelegateWithFixedCrossAxisCount;
    expect(delegate.crossAxisCount, inInclusiveRange(3, 10));
  });
}
