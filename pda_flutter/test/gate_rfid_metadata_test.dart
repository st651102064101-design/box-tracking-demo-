import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/services/prefs.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';
import 'app_controller_test.dart' show FakeApi, fixtureState;
import 'handheld_matrix_test.dart' show ProbeRfid;

class _Api extends FakeApi {
  final metadata = <List<Map<String, dynamic>>>[];
  final wait = Completer<void>();
  @override
  Future<void> observeRadar(List<Map<String, dynamic>> rows) async {
    metadata.add(rows);
    await wait.future;
    throw Exception('metadata offline');
  }
}

class _Sdk extends ProbeRfid {
  _Sdk()
      : super({'model': 'MC3390R', 'manufacturer': 'Zebra', 'brand': 'Zebra'});
  int tidReads = 0;
  @override
  Future<String?> readTid(String epc) async {
    tidReads++;
    return 'E2801190';
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final direction in ['in', 'out']) {
    test(
        '$direction RFID duplicate storm submits once while tag-metadata API is blocked',
        () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final api = _Api()..state = fixtureState();
      final sdk = _Sdk();
      final c = AppController(
          api: api, prefs: prefs, rfid: sdk, readLanIp: () async => '');
      await c.init();
      await c.refresh();
      c.wh = 'WH-1';
      c.gate = '3';
      c.emp = c.employees.first;
      if (direction == 'in')
        c.goScanIn();
      else
        c.goScanOut();
      c.gateFormStep = false;
      c.setInPlate('TEST-123');
      c.setOutPlate('TEST-123');
      c.outCustomer = 'CUST-01';
      c.setScanInputMode(ScanInputMode.rfid);
      await Future<void>.delayed(Duration.zero);
      var notifications = 0;
      c.addListener(() => notifications++);
      final tag = direction == 'in' ? 'CRT-02' : 'CRT-01';
      final epc = tag.codeUnits
          .map((b) => b.toRadixString(16).padLeft(2, '0'))
          .join()
          .toUpperCase();
      sdk.readBatch(List.generate(1000,
          (_) => RfidTagRead(epc: epc, rssi: -70, readAt: DateTime.now())));
      await Future<void>.delayed(Duration.zero);
      expect(c.queue, [tag]);
      expect(api.metadata, isEmpty);
      expect(notifications, 1,
          reason: 'a duplicate storm must not rebuild the UI 1000 times');
      notifications = 0;
      sdk.readBatch(List.generate(1000,
          (_) => RfidTagRead(epc: epc, rssi: -70, readAt: DateTime.now())));
      await Future<void>.delayed(Duration.zero);
      expect(notifications, 0,
          reason: 'a held trigger must keep the accepted result stable');
      sdk.scan('CRT-03'); // Imager cannot add a box in RFID mode.
      sdk.pull(false);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(api.metadata.single, hasLength(1));
      expect(sdk.tidReads, 1);
      await Future.wait([c.doCommit(), c.doCommit()]);
      final gateCalls = direction == 'in' ? api.gateInCalls : api.gateOutCalls;
      expect(gateCalls, hasLength(1));
      expect(gateCalls.single['tags'], [tag]);
      expect(c.queue, isEmpty);
      expect(c.busy, isFalse);
      api.wait.complete();
      await Future<void>.delayed(Duration.zero);
      c.dispose();
    });
  }
}
