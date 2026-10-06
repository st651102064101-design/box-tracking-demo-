import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/rfid_locate_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/services/prefs.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';
import 'package:smarttrace_pda/widgets/scan_prompt_card.dart';
import 'app_controller_test.dart' show FakeApi, fixtureState;

class _Reader extends RfidService {
  final batches = StreamController<List<RfidTagRead>>.broadcast();
  @override
  Stream<List<RfidTagRead>> get tagBatches => batches.stream;
  @override
  bool get supported => false;
  void emit(int? rssi) => batches.add([
        RfidTagRead(epc: 'TAG-1', rssi: rssi, readAt: DateTime.now()),
      ]);
}

void main() {
  testWidgets(
      'radar shows approximate metres and signal trend, then clears stale readings',
      (tester) async {
    tester.view.physicalSize = const Size(400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    prefs.hideMaxRangeAlert = true;
    final api = FakeApi()..state = fixtureState();
    api.state['boxes']['CRT-01']['rfid'] = 'TAG-1';
    api.state['boxes']['CRT-02']['rfid'] = 'TAG-2';
    final reader = _Reader();
    final c = AppController(api: api, prefs: prefs, rfid: reader);
    await c.refresh();
    c.screen = Screen.rfidLocate;
    var now = DateTime(2026);
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(prefs)),
      ],
      child: MaterialApp(home: Scaffold(body: RfidLocateScreen(now: () => now))),
    ));
    await tester.pump();
    expect(find.byType(ScanPromptCard), findsOneWidget);
    expect(find.text('กดปุ่ม SCANNER ที่เครื่อง'), findsOneWidget);
    await tester.tap(find.text('CRT-01'));
    await tester.pump();
    expect(find.textContaining('แล้วกดเทียบระยะ'), findsNothing);
    expect(find.text('—'), findsOneWidget);
    reader.emit(-60);
    await tester.pump();
    expect(find.text('≈ 1 ม.'), findsOneWidget);
    expect(find.text('%'), findsNothing);
    reader.emit(-80);
    await tester.pump();
    // An isolated weaker sample must not jump the distance immediately.
    expect(find.text('≈ 1 ม.'), findsOneWidget);
    reader.emit(null);
    await tester.pump();
    expect(find.text('—'), findsOneWidget);
    reader.emit(-60);
    await tester.pump();
    expect(find.text('≈ 1 ม.'), findsOneWidget);
    now = now.add(const Duration(seconds: 2));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('—'), findsOneWidget);
    c.systemBackOverride!();
    await tester.pump();
    await tester.tap(find.text('CRT-02'));
    await tester.pump();
    expect(find.text('—'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    c.dispose();
    await reader.batches.close();
  });
}
