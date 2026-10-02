import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/services/prefs.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';
import 'app_controller_test.dart' show FakeApi, fixtureState;
import 'handheld_matrix_test.dart' show ProbeRfid;

Future<void> settle() => Future<void>.delayed(Duration.zero);
RfidTagRead read(String epc) => RfidTagRead(epc: epc, readAt: DateTime.now());

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppController c;
  late ProbeRfid sdk;
  late FakeApi api;
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    api = FakeApi()..state = fixtureState();
    (api.state['boxes']['CRT-02'] as Map)['rfid'] = 'E200ABCD';
    (api.state['boxes']['CRT-01'] as Map)['rfid'] = 'E2001122';
    sdk = ProbeRfid({'model': 'TC501', 'manufacturer': 'Zebra', 'brand': 'Zebra'});
    c = AppController(api: api, prefs: prefs, rfid: sdk, readLanIp: () async => '');
    await c.init();
    await c.refresh();
    c.wh = 'WH-1';
    c.gate = '2';
    c.emp = c.employees.firstWhere((e) => e.id == 'EMP-0001');
    await settle();
  });
  tearDown(() { c.dispose(); });

  for (final screen in [Screen.track, Screen.transfer, Screen.cycleCount]) {
    test('late antenna batch in barcode mode leaves $screen results unchanged', () async {
      c.go(screen);
      c.setScanInputMode(ScanInputMode.barcode);
      sdk.readBatch([read('E200ABCD'), read('E2001122')]);
      await settle();
      expect(c.trackRfidHits, isEmpty);
      expect(c.transferRfidHits, isEmpty);
      expect(c.cycleCountRfidHits, isEmpty);
      expect(api.gateInCalls, isEmpty);
      expect(api.gateOutCalls, isEmpty);
    });
  }
  test('RFID mode rejects barcode intent without callback, queue, or API side effects', () async {
    c.goScanIn();
    c.gateFormStep = false;
    c.setScanInputMode(ScanInputMode.rfid);
    final delivered = <String>[];
    c.claimBarcodeTarget(delivered.add);
    sdk.scan('CRT-02');
    await settle();
    expect(delivered, isEmpty);
    expect(c.queue, isEmpty);
    expect(c.lastResult, isNull);
    expect(api.gateInCalls, isEmpty);
    sdk.readBatch([read('E200ABCD'), read('E200ABCD')]);
    await settle();
    expect(c.queue, ['CRT-02']);
  });
  test('RFID to barcode switch rejects late reads and routes next barcode once', () async {
    c.goScanIn();
    c.gateFormStep = false;
    c.setScanInputMode(ScanInputMode.rfid);
    c.setScanInputMode(ScanInputMode.barcode);
    sdk.readBatch([read('E200ABCD')]);
    await settle();
    expect(c.queue, isEmpty);
    sdk.scan(']C1CRT-02\r\n');
    sdk.scan('CRT-02');
    await settle();
    expect(c.queue, ['CRT-02']);
    expect(sdk.calls, contains('stopInventory'));
  });
  test('controller disposal cancels barcode, trigger and tag subscriptions', () async {
    c.goTrack();
    c.setScanInputMode(ScanInputMode.rfid);
    c.dispose();
    sdk.calls.clear();
    sdk.readBatch([read('E200ABCD')]);
    sdk.scan('CRT-02');
    sdk.pull(true);
    await settle();
    expect(c.trackRfidHits, isEmpty);
    expect(sdk.calls, isEmpty);
    // Replacing the disposed instance keeps teardown valid.
    c = AppController(api: api, prefs: await Prefs.load(), rfid: ProbeRfid({}));
  });
  test('concurrent submit of one scan batch makes exactly one gate API call', () async {
    c.goScanIn();
    c.gateFormStep = false;
    c.online = true;
    c.addScan('CRT-02');
    await Future.wait([c.doCommit(), c.doCommit()]);
    expect(api.gateInCalls, hasLength(1));
    expect(c.queue, isEmpty);
    expect(c.busy, isFalse);
  });
  test('shared trigger in barcode mode starts imager only and release stops it', () async {
    c.goTrack();
    c.setScanInputMode(ScanInputMode.barcode);
    sdk.calls.clear();
    sdk.pull(true);
    await settle();
    expect(sdk.calls, contains('barcodeTrigger:true'));
    expect(sdk.calls, isNot(contains('startInventory')));
    sdk.pull(false);
    await settle();
    expect(sdk.calls, contains('barcodeTrigger:false'));
    sdk.calls.clear();
    c.backToHome();
    expect(sdk.calls, contains('barcodeTrigger:false'));
    c.goTrack();
    c.setScanInputMode(ScanInputMode.rfid);
    sdk.calls.clear();
    sdk.pull(true);
    await settle();
    expect(sdk.calls, isNot(contains('barcodeTrigger:true')));
  });
}
