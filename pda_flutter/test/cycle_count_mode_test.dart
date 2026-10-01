import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/screens/cycle_count_screen.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/widgets/scan_capture.dart';
import 'app_controller_test.dart' show FakeApi, makeController;

class CountApi extends FakeApi {
  final scans = <List<String>>[];
  Map<String, dynamic> session() => {
    'id': 'CC-TEST', 'zone': '', 'expected': ['CRT-01'],
    'counted': [], 'missing': ['CRT-01'], 'unexpected': [],
    'summary': {'expected': 1, 'counted': 0, 'missing': 1, 'unexpected': 0},
  };
  @override
  Future<Map<String, dynamic>> openCycleCount({required String wh, String zone = ''}) async => session();
  @override
  Future<Map<String, dynamic>> cycleCountScan(String id, List<String> tags) async {
    scans.add(List.of(tags));
    return session();
  }
}
void main() {
  testWidgets('RFID selection disables wedge capture and barcode selection submits exactly once', (tester) async {
    final api = CountApi();
    final c = await makeController(api);
    c.debugHasIntegratedRfid = true;
    c.goCycleCount();
    await tester.pumpWidget(MultiProvider(
      providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(value: LocaleController(c.prefs)),
      ],
      child: const MaterialApp(home: Scaffold(body: CycleCountScreen())),
    ));
    await tester.pump();
    await tester.pump();
    c.setScanInputMode(ScanInputMode.rfid);
    await tester.pump();
    expect(tester.widget<ScanCapture>(find.byType(ScanCapture)).enabled, isFalse);
    await tester.enterText(find.byType(TextField), 'CRT-01');
    await tester.pump(const Duration(milliseconds: 250));
    expect(api.scans, isEmpty, reason: 'barcode must not POST while RFID is selected');
    c.setScanInputMode(ScanInputMode.barcode);
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'CRT-01');
    await tester.pump();
    expect(api.scans, [['CRT-01']]);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}
