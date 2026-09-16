import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/services/api_client.dart';
import 'package:smarttrace_pda/services/prefs.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppController c;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = Prefs(await SharedPreferences.getInstance());
    c = AppController(
      api: ApiClient(baseUrl: 'http://test'),
      prefs: prefs,
      rfid: RfidService(),
    );
  });

  test('TC52-like handheld cannot open RFID destinations', () {
    c.debugSetHandheldCapability(hasIntegratedRfid: false, usesZebraSdk: true);

    c.goLocate();
    expect(c.screen, isNot(Screen.rfidLocate));

    c.goBoxRegister();
    expect(c.screen, isNot(Screen.boxRegister));

    c.go(Screen.rfidInput);
    expect(c.screen, isNot(Screen.rfidInput));

    c.go(Screen.rfidLocate);
    expect(c.screen, isNot(Screen.rfidLocate));
  });

  test('RFID mode is forced back to barcode without integrated RFID', () {
    c.debugSetHandheldCapability(hasIntegratedRfid: false, usesZebraSdk: true);
    c.setScanInputMode(ScanInputMode.rfid);
    expect(c.scanInputMode, ScanInputMode.barcode);
  });

  test('MC3390R-like handheld can open RFID locate', () {
    c.debugSetHandheldCapability(hasIntegratedRfid: true, usesZebraSdk: true);
    c.screen = Screen.home;
    c.goLocate();
    expect(c.screen, Screen.rfidLocate);
  });
}
