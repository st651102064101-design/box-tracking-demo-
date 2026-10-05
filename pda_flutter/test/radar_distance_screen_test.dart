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
      'distance appears without calibration and disappears on stale '
      'or missing RSSI; a different box cannot reuse its reading',
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
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(
            value: LocaleController(prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: RfidLocateScreen())),
    ));
    await tester.pump();
    expect(find.byType(ScanPromptCard), findsOneWidget);
    expect(find.text('กดปุ่ม SCANNER ที่เครื่อง'), findsOneWidget);
    await tester.tap(find.text('CRT-01'));
    await tester.pump();
    expect(find.textContaining('แล้วกดเทียบระยะ'), findsNothing);
    reader.emit(null);
    await tester.pump();
    expect(find.text('≈ 1 ม.'), findsNothing);
    reader.emit(-60);
    await tester.pump();
    expect(find.text('≈ 1 ม.'), findsOneWidget);
    expect(find.text('%'), findsNothing);
    reader.emit(-80);
    await tester.pump();
    // An isolated weaker sample must not jump the distance immediately.
    expect(find.text('≈ 3 ม. 20 ซม.'), findsNothing);
    reader.emit(null);
    await tester.pump();
    expect(find.text('≈ 3 ม. 20 ซม.'), findsNothing);
    reader.emit(-60);
    await tester.pump();
    expect(find.text('≈ 1 ม.'), findsOneWidget);
    // The screen uses wall-clock timestamps; pump advances only fake timers.
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1600)));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('≈ 1 ม.'), findsNothing);
    c.systemBackOverride!();
    await tester.pump();
    await tester.tap(find.text('CRT-02'));
    await tester.pump();
    expect(find.text('≈ 1 ม.'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    c.dispose();
    await reader.batches.close();
  });
}
