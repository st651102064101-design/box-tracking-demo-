import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/services/prefs.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';
import 'package:smarttrace_pda/widgets/common.dart';
import 'app_controller_test.dart' show FakeApi, fixtureState;
import 'handheld_matrix_test.dart' show ProbeRfid;

void main() {
  for (final model in ['MC3390R', 'TC501']) {
    testWidgets('$model UI switch RFID to Barcode arms imager and routes only barcode', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final api = FakeApi()..state = fixtureState();
      api.state['boxes']['CRT-01']['rfid'] = 'KNOWN';
      final sdk = ProbeRfid({'model': model, 'manufacturer': 'Zebra', 'brand': 'Zebra'});
      final c = AppController(api: api, prefs: prefs, rfid: sdk, readLanIp: () async => '');
      await c.init();
      await c.refresh();
      c.goTrack();
      await tester.pumpWidget(MultiProvider(providers: [
        ChangeNotifierProvider<AppController>.value(value: c),
        ChangeNotifierProvider<LocaleController>.value(value: LocaleController(prefs)),
      ], child: const MaterialApp(home: Scaffold(body: ScanModeToggle()))));
      final decoded = <String>[];
      c.claimBarcodeTarget(decoded.add);
      for (var i = 0; i < 3; i++) {
        await tester.tap(find.text('RFID'));
        await tester.pump();
        expect(c.scanInputMode, ScanInputMode.rfid);
        sdk.scan('CRT-01');
        await tester.pump();
        expect(decoded.length, i);
        sdk.calls.clear();
        await tester.tap(find.text('บาร์โค้ด'));
        await tester.pump();
        expect(c.scanInputMode, ScanInputMode.barcode);
        expect(sdk.calls, contains('rfidTrigger:false'));
        expect(sdk.calls, contains('stopInventory'));
        sdk.calls.clear();
        sdk.pull(true);
        await tester.pump();
        expect(sdk.calls, contains('barcodeTrigger:true'));
        expect(sdk.calls, isNot(contains('startInventory')));
        sdk.readBatch([RfidTagRead(epc: 'KNOWN', readAt: DateTime.now())]);
        sdk.scan('CRT-0${i + 1}');
        await tester.pump();
        expect(decoded.length, i + 1);
        expect(c.trackRfidHits, isEmpty);
        sdk.pull(false);
        await tester.pump();
        expect(sdk.calls, contains('barcodeTrigger:false'));
      }
      c.releaseBarcodeTarget(decoded.add);
      await tester.pumpWidget(const SizedBox.shrink());
      c.dispose();
      expect(tester.takeException(), isNull);
    });
  }
}
