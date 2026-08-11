import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/hold_release_screen.dart';
import 'package:smarttrace_pda/screens/report_problem_screen.dart';
import 'package:smarttrace_pda/screens/location_inquiry_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';

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

    testWidgets(
        'the ของหาย pick list offers on-hand boxes only, and picking one files the report',
        (tester) async {
      final api = FakeApi();
      final c = await makeController(api);
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('ของหาย'));
      await tester.pump();

      // The whole point of this list: the box being reported is the one that
      // can't be scanned. warehouse/damage/hold are all physically on hand.
      expect(find.text('CRT-01'), findsOneWidget); // warehouse
      expect(find.text('CRT-05'), findsOneWidget); // damage
      expect(find.text('CRT-06'), findsOneWidget); // hold
      // …but "I went there and it wasn't there" is meaningless for a box
      // that's out at a customer, was never received, or is already lost.
      expect(find.text('CRT-02'), findsNothing); // out
      expect(find.text('CRT-03'), findsNothing); // pending
      expect(find.text('CRT-04'), findsNothing); // lost

      // Tapping a row lands on the same confirm step a scan reaches.
      await tester.tap(find.text('CRT-05'));
      await tester.pump();
      await tester.tap(find.text('ส่งรายงาน'));
      await tester.pump();
      await tester.pump();

      expect(api.reportCalls, hasLength(1));
      expect(api.reportCalls.first['kind'], 'missing');
      expect(api.reportCalls.first['tag'], 'CRT-05');
    });

    testWidgets('the ของหาย pick list filters by product type', (tester) async {
      final c = await makeController(FakeApi()..state = _twoTypeState());
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('ของหาย'));
      await tester.pump();

      expect(find.widgetWithText(ChoiceChip, 'ทั้งหมด'), findsOneWidget);
      expect(find.widgetWithText(ChoiceChip, 'ลังพลาสติก 60L'), findsOneWidget);
      expect(find.widgetWithText(ChoiceChip, 'พาเลทไม้'), findsOneWidget);
      expect(find.text('BOX-A1'), findsOneWidget);
      expect(find.text('BOX-B1'), findsOneWidget);

      await tester.tap(find.widgetWithText(ChoiceChip, 'พาเลทไม้'));
      await tester.pump();
      expect(find.text('BOX-B1'), findsOneWidget);
      expect(find.text('BOX-A1'), findsNothing);

      await tester.tap(find.widgetWithText(ChoiceChip, 'ทั้งหมด'));
      await tester.pump();
      expect(find.text('BOX-A1'), findsOneWidget);
      expect(find.text('BOX-B1'), findsOneWidget);
    });

    testWidgets('no type chip row when every on-hand box shares one type',
        (tester) async {
      // fixtureState()'s boxes are all BT-CRT — nothing to filter between.
      final c = await makeController(FakeApi());
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('ของหาย'));
      await tester.pump();

      expect(find.widgetWithText(ChoiceChip, 'ทั้งหมด'), findsNothing);
      expect(find.text('CRT-01'), findsOneWidget);
    });

    // "ช่องเก็บเต็ม" was dropped from the floor menu entirely — no resolve
    // step would mean anything box-shaped for a location-scoped report, and
    // Location Master already covers clearing that flag from the dashboard.
    // "กล่องชำรุด" stayed, alongside the two original box-scoped kinds.
    testWidgets('offers the three box-scoped report kinds, not ช่องเก็บเต็ม',
        (tester) async {
      final state = fixtureStateWithLocation();
      final c = await makeController(FakeApi()..state = state);
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      expect(find.text('ของหาย'), findsOneWidget);
      expect(find.text('อ่านแท็กไม่ติด / ป้ายหาย'), findsOneWidget);
      expect(find.text('กล่องชำรุด'), findsOneWidget);
      expect(find.text('ช่องเก็บเต็ม'), findsNothing);
    });

    testWidgets('reports an unreadable tag by box', (tester) async {
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

      // The standalone RFID tag-binding screen was removed — no
      // "ไปผูกแท็กใหม่" shortcut left here to offer.
      expect(find.text('ไปผูกแท็กใหม่'), findsNothing);
    });

    testWidgets('reports a damaged box by tag', (tester) async {
      final api = FakeApi();
      final c = await makeController(api);
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('กล่องชำรุด'));
      await tester.pump();
      await scan(tester, 'CRT-01'); // warehouse, per fixtureState()
      await tester.pump();

      expect(find.text('CRT-01'), findsOneWidget);
      await tester.tap(find.text('ส่งรายงาน'));
      await tester.pump();
      await tester.pump();

      expect(api.reportCalls, hasLength(1));
      expect(api.reportCalls.first['kind'], 'damaged');
      expect(api.reportCalls.first['tag'], 'CRT-01');
      expect(find.text('บันทึกรายงานแล้ว'), findsOneWidget);
    });

    testWidgets('a box already flagged damaged is not offered again',
        (tester) async {
      final c = await makeController(FakeApi());
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('กล่องชำรุด'));
      await tester.pump();

      // CRT-05 is already status 'damage' per fixtureState() — offering to
      // file a second damage report on it would just 409 the way the
      // backend's own duplicate check refuses it.
      expect(find.text('CRT-05'), findsNothing);
    });

    testWidgets('ปิดปัญหา mode resolves a lost box back to normal',
        (tester) async {
      final api = FakeApi();
      final c = await makeController(api);
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('ปิดปัญหา'));
      await tester.pump();
      await tester.tap(find.text('เจอของแล้ว'));
      await tester.pump();

      // CRT-04 is 'lost' per fixtureState() — the only kind of box this mode
      // should offer for "ของหาย".
      expect(find.text('CRT-04'), findsOneWidget);
      // CRT-01 is on-hand, not lost — nothing to resolve there.
      expect(find.text('CRT-01'), findsNothing);

      await scan(tester, 'CRT-04');
      await tester.pump();
      await tester.tap(find.text('เจอของแล้ว').last);
      await tester.pump();
      await tester.pump();

      expect(api.resolveReportCalls, [
        {'kind': 'missing', 'tag': 'CRT-04'}
      ]);
      expect(find.text('ปิดปัญหาแล้ว'), findsOneWidget);
    });

    testWidgets('ปิดปัญหา mode refuses a box with nothing open',
        (tester) async {
      final c = await makeController(FakeApi());
      await tester.pumpWidget(await _wrap(c, const ReportProblemScreen()));
      await tester.pump();

      await tester.tap(find.text('ปิดปัญหา'));
      await tester.pump();
      await tester.tap(find.text('ซ่อมแล้ว'));
      await tester.pump();
      await scan(tester, 'CRT-01'); // warehouse, not damaged
      await tester.pump();

      expect(find.textContaining('ไม่ได้เปิดปัญหานี้ไว้'), findsOneWidget);
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

/// Two on-hand boxes of two different product types — the minimum needed for
/// ReportProblemScreen's pick-list type filter to have anything to filter
/// between (the shared fixtureState() is single-type by design).
Map<String, dynamic> _twoTypeState() => {
      'boxes': {
        'BOX-A1': box('BOX-A1', 'warehouse'), // box() hardcodes type BT-CRT
        'BOX-B1': box('BOX-B1', 'warehouse')..['type'] = 'BT-PLT',
      },
      'customers': <String, dynamic>{},
      'boxtypes': {
        'BT-CRT': {'id': 'BT-CRT', 'name': 'ลังพลาสติก 60L'},
        'BT-PLT': {'id': 'BT-PLT', 'name': 'พาเลทไม้'},
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
      'employees': fixtureEmployees(),
      'events': <dynamic>[],
      'cfg': {'agingDays': 15},
    };

/// fixtureState() plus a master location LOC-A11 (occupied by CRT-01) and
/// LOC-A99 (defined, empty) — what LocationInquiryScreen needs to resolve a
/// scanned shelf code.
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
