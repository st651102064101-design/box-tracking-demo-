import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:boxtrace_pda/controllers/app_controller.dart';
import 'package:boxtrace_pda/screens/hold_release_screen.dart';
import 'package:boxtrace_pda/screens/report_problem_screen.dart';
import 'package:boxtrace_pda/screens/location_inquiry_screen.dart';
import 'package:boxtrace_pda/services/i18n.dart';

import 'app_controller_test.dart'
    show FakeApi, makeController, fixtureEmployees, box;

/// Covers the three "floor exception" screens added alongside
/// POST /api/boxes/:tag/hold and POST /api/reports: HoldReleaseScreen,
/// ReportProblemScreen, and LocationInquiryScreen (the client-side reverse
/// of "หากล่อง"). Each is driven the way the imager actually feeds them —
/// [scan] types into the hidden ScanCapture field the way a wedge scanner
/// does — not by calling controller methods directly.
Future<void> scan(WidgetTester tester, String code) =>
    tester.enterText(find.byType(TextField).first, code);

Future<Widget> _wrap(AppController c, Widget child) async {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<AppController>.value(value: c),
      ChangeNotifierProvider<LocaleController>.value(
          value: LocaleController(c.prefs)),
    ],
    child: MaterialApp(home: Scaffold(body: child)),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('HoldReleaseScreen', () {
    testWidgets('holds a warehoused box and calls the API', (tester) async {
      final api = FakeApi();
      final c = await makeController(api);
      await tester.pumpWidget(await _wrap(c, const HoldReleaseScreen()));
      await tester.pump();

      await scan(tester, 'CRT-01'); // warehouse, per fixtureState()
      await tester.pump();

      expect(find.text('CRT-01'), findsOneWidget);
      expect(find.text('พักสินค้า (Hold)'), findsOneWidget);
      // Already warehouse — release isn't offered.
      expect(find.text('ปลดพัก — กลับเป็นปกติ'), findsNothing);

      await tester.tap(find.text('พักสินค้า (Hold)'));
      await tester.pump();
      await tester.pump();

      expect(api.holdCalls, [
        {'tag': 'CRT-01', 'status': 'hold', 'reason': ''}
      ]);
      // Back to the scan step after a successful action.
      expect(find.text('CRT-01'), findsNothing);
      // Let toastMsg's own 2.6s auto-clear timer fire before teardown, or
      // the test framework flags it as a leaked pending timer.
      await tester.pump(const Duration(milliseconds: 2700));
    });

    testWidgets('an already-held box offers release, not hold again',
        (tester) async {
      final c = await makeController(FakeApi());
      await tester.pumpWidget(await _wrap(c, const HoldReleaseScreen()));
      await tester.pump();

      await scan(tester, 'CRT-06'); // hold, per fixtureState()
      await tester.pump();

      expect(find.text('ปลดพัก — กลับเป็นปกติ'), findsOneWidget);
      expect(find.text('พักสินค้า (Hold)'), findsNothing);
    });

    testWidgets('refuses a box that already shipped out', (tester) async {
      final c = await makeController(FakeApi());
      await tester.pumpWidget(await _wrap(c, const HoldReleaseScreen()));
      await tester.pump();

      await scan(tester, 'CRT-02'); // out, per fixtureState()
      await tester.pump();

      expect(find.textContaining('พัก/แจ้งชำรุดได้เฉพาะกล่องที่อยู่ในคลัง'),
          findsOneWidget);
      expect(find.text('พักสินค้า (Hold)'), findsNothing);
    });
  });

  group('ReportProblemScreen', () {
    testWidgets('reports a missing box by tag', (tester) async {
      final api = FakeApi();
      final c = await makeController(api);
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('ของหาย'));
      await tester.pump();
      await scan(tester, 'CRT-01');
      await tester.pump();

      expect(find.text('CRT-01'), findsOneWidget);
      await tester.tap(find.text('ส่งรายงาน'));
      await tester.pump();
      await tester.pump();

      expect(api.reportCalls, hasLength(1));
      expect(api.reportCalls.first['kind'], 'missing');
      expect(api.reportCalls.first['tag'], 'CRT-01');
      expect(find.text('บันทึกรายงานแล้ว'), findsOneWidget);
    });

    testWidgets('reports a full bin by location, with no box tag',
        (tester) async {
      final api = FakeApi();
      final state = fixtureStateWithLocation();
      final c = await makeController(FakeApi()..state = state);
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('ช่องเก็บเต็ม'));
      await tester.pump();
      await scan(tester, 'LOC-A11');
      await tester.pump();

      expect(find.text('A / 1 / 1'), findsOneWidget);
      await tester.tap(find.text('ส่งรายงาน'));
      await tester.pump();
      await tester.pump();

      // Reports through this widget's own controller (built with `c`), not
      // `api` — assert against the api actually wired to c.
      final calls = (c.api as FakeApi).reportCalls;
      expect(calls, hasLength(1));
      expect(calls.first['kind'], 'bin_full');
      expect(calls.first['tag'], isNull);
      expect(calls.first['location'], isNotNull);
    });

    testWidgets(
        'reports an unreadable tag by box, then offers a shortcut to re-tag',
        (tester) async {
      final api = FakeApi();
      final c = await makeController(api);
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('อ่านแท็กไม่ติด / ป้ายหาย'));
      await tester.pump();
      await scan(tester, 'CRT-01');
      await tester.pump();

      expect(find.text('CRT-01'), findsOneWidget);
      await tester.tap(find.text('ส่งรายงาน'));
      await tester.pump();
      await tester.pump();

      expect(api.reportCalls, hasLength(1));
      expect(api.reportCalls.first['kind'], 'unreadable_tag');
      expect(api.reportCalls.first['tag'], 'CRT-01');
      expect(find.text('บันทึกรายงานแล้ว'), findsOneWidget);

      // The box still needs a working tag — offer the fast path there
      // instead of just dropping the operator back at a menu.
      expect(find.text('ไปผูกแท็กใหม่'), findsOneWidget);
      await tester.tap(find.text('ไปผูกแท็กใหม่'));
      await tester.pump();
      expect(c.screen, Screen.rfidRegister);
    });

    testWidgets('กล่องชำรุด forwards straight into HoldReleaseScreen',
        (tester) async {
      final c = await makeController(FakeApi());
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('กล่องชำรุด'));
      await tester.pump();
      expect(c.screen, Screen.holdRelease);
    });
  });

  group('LocationInquiryScreen', () {
    testWidgets('scanning a shelf lists the boxes recorded there',
        (tester) async {
      final state = fixtureStateWithLocation();
      final c = await makeController(FakeApi()..state = state);
      await tester.pumpWidget(await _wrap(c, const LocationInquiryScreen()));
      await tester.pump();

      await scan(tester, 'LOC-A11');
      await tester.pump();

      expect(find.text('A / 1 / 1'), findsOneWidget);
      expect(find.textContaining('1'), findsWidgets); // "1 ใบที่นี่"
      expect(find.text('CRT-01'), findsOneWidget);
    });

    testWidgets('an empty shelf says so', (tester) async {
      final state = fixtureStateWithLocation();
      final c = await makeController(FakeApi()..state = state);
      await tester.pumpWidget(await _wrap(c, const LocationInquiryScreen()));
      await tester.pump();

      await scan(tester, 'LOC-A99');
      await tester.pump();

      expect(find.text('ระบบไม่พบกล่องบันทึกไว้ที่ช่องนี้'), findsOneWidget);
    });
  });
}

/// fixtureState() plus a master location LOC-A11 (occupied by CRT-01) and
/// LOC-A99 (defined, empty) — what LocationInquiryScreen and the bin_full
/// report path both need to resolve a scanned shelf code.
Map<String, dynamic> fixtureStateWithLocation() {
  final boxes = <String, dynamic>{
    'CRT-01': box('CRT-01', 'warehouse')
      ..['location'] = {
        'wh': 'WH-1',
        'zone': 'A',
        'rack': '1',
        'shelf': '1',
        'slot': ''
      },
    'CRT-02': box('CRT-02', 'out'),
  };
  return {
    'boxes': boxes,
    'customers': <String, dynamic>{},
    'boxtypes': {
      'BT-CRT': {'id': 'BT-CRT', 'name': 'ลังพลาสติก 60L'}
    },
    'warehouses': {
      'WH-1': {
        'id': 'WH-1',
        'name': 'คลัง 1',
        'gates': [1, 2, 3],
        'gateTypes': {'1': 'in', '2': 'out', '3': 'both'},
      }
    },
    'gates': {'1': 'WH-1', '2': 'WH-1', '3': 'WH-1'},
    'locations': {
      'LOC-A11': {
        'wh': 'WH-1',
        'zone': 'A',
        'rack': '1',
        'shelf': '1',
        'slot': ''
      },
      'LOC-A99': {
        'wh': 'WH-1',
        'zone': 'A',
        'rack': '9',
        'shelf': '9',
        'slot': ''
      },
    },
    'employees': fixtureEmployees(),
    'events': <dynamic>[],
    'cfg': {'agingDays': 15},
  };
}
