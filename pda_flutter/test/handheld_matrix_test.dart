import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:smarttrace_pda/controllers/app_controller.dart';
import 'package:smarttrace_pda/services/handheld_profile.dart';
import 'package:smarttrace_pda/screens/device_setup_screen.dart';
import 'package:smarttrace_pda/screens/more_hub_screen.dart';
import 'package:smarttrace_pda/screens/settings_screen.dart';
import 'package:smarttrace_pda/screens/track_screen.dart';
import 'package:smarttrace_pda/services/api_client.dart';
import 'package:smarttrace_pda/services/i18n.dart';
import 'package:smarttrace_pda/services/prefs.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';
import 'package:smarttrace_pda/services/theme_controller.dart';

import 'app_controller_test.dart' show FakeApi, fixtureState;

/// Records Zebra bridge calls and lets a test fire the trigger or a barcode
/// without a handheld attached.
class ProbeRfid extends RfidService {
  ProbeRfid(this.info);

  final Map<String, dynamic> info;
  final calls = <String>[];
  final _triggers = StreamController<bool>.broadcast();
  final _barcodes = StreamController<String>.broadcast();
  final _tags = StreamController<List<RfidTagRead>>.broadcast();
  final _status = StreamController<RfidStatus>.broadcast();

  @override
  bool get supported => true;

  @override
  Stream<bool> get triggers => _triggers.stream;

  @override
  Stream<String> get barcodes => _barcodes.stream;

  @override
  Stream<List<RfidTagRead>> get tagBatches => _tags.stream;

  @override
  Stream<RfidStatus> get status => _status.stream;

  void pull(bool pressed) => _triggers.add(pressed);

  void scan(String code) => _barcodes.add(code);

  void readBatch(List<RfidTagRead> reads) => _tags.add(reads);

  void _rec(String name) => calls.add(name);

  @override
  void ensureListening() {}

  @override
  Future<Map<String, dynamic>> deviceInfo() async => info;

  @override
  Future<void> connect() async => _rec('connect');

  @override
  Future<void> startInventory() async => _rec('startInventory');

  @override
  Future<void> stopInventory() async => _rec('stopInventory');

  @override
  Future<void> prepareBarcodeDataWedge() async =>
      _rec('prepareBarcodeDataWedge');

  @override
  Future<void> setRfidTriggerMode(bool enabled) async =>
      _rec('rfidTrigger:$enabled');

  @override
  Future<void> setBarcodeScannerEnabled(bool enabled) async =>
      _rec('barcode:$enabled');

  @override
  Future<void> setAutoBeep(bool enabled) async {}

  @override
  Future<void> setPowerPercent(int percent) async {}

  @override
  Future<void> setRfidSoundId(String soundId) async {}

  @override
  Future<void> setSoundVolume(double volume) async {}

  bool get startedInventory => calls.contains('startInventory');

  String? get lastRfidTrigger {
    final hits = calls.where((c) => c.startsWith('rfidTrigger:'));
    return hits.isEmpty ? null : hits.last;
  }

  bool get touchedRfidTrigger => calls.any((c) => c.startsWith('rfidTrigger:'));
}

Map<String, dynamic> _zebra(String model) => {
      'model': model,
      'manufacturer': 'Zebra Technologies',
      'brand': 'Zebra',
    };

Future<({AppController c, ProbeRfid rfid, FakeApi api})> _boot(
  String model, {
  String? savedModel,
}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await Prefs.load();
  final api = FakeApi()..state = fixtureState();
  final rfid = ProbeRfid(_zebra(model));
  final c = AppController(
    api: api,
    prefs: prefs,
    rfid: rfid,
    readLanIp: () async => '192.168.1.50',
  );
  await c.refresh();
  c.wh = 'WH-1';
  c.gate = '2';
  prefs.deviceWh = 'WH-1';
  prefs.deviceGate = '2';
  prefs.deviceConfigured = true;
  prefs.token = 'device-token';
  api.token = 'device-token';
  if (savedModel != null) prefs.deviceModel = savedModel;
  c.emp = c.employees.firstWhere((e) => e.id == 'EMP-0001');
  await c.init();
  await Future<void>.delayed(Duration.zero);
  return (c: c, rfid: rfid, api: api);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('model detection', () {
    test('TC52 is barcode-only and stored as tc52', () async {
      final h = await _boot('TC52');
      expect(h.c.hasIntegratedRfid, isFalse);
      expect(h.c.usesZebraSdk, isTrue);
      expect(h.c.prefs.deviceModel, 'tc52');
      h.c.dispose();
    });

    test('MC3390R is an integrated RFID handheld', () async {
      final h = await _boot('MC3390R');
      expect(h.c.hasIntegratedRfid, isTrue);
      expect(h.c.usesZebraSdk, isTrue);
      expect(h.c.prefs.deviceModel, 'mc3390r');
      h.c.dispose();
    });

    test('TC501 is an integrated RFID handheld, not a TC52', () async {
      final h = await _boot('TC501');
      expect(h.c.hasIntegratedRfid, isTrue,
          reason: 'TC501 has a built-in UHF reader');
      expect(h.c.prefs.deviceModel, 'tc501');
      expect(h.c.prefs.deviceModel, isNot('tc52'));
      h.c.dispose();
    });

    test('a saved RFID profile is cleared when the hardware is a TC52',
        () async {
      final fromMc = await _boot('TC52', savedModel: 'mc3390r');
      expect(fromMc.c.hasIntegratedRfid, isFalse);
      expect(fromMc.c.prefs.deviceModel, 'tc52');
      fromMc.c.dispose();

      final fromTc501 = await _boot('TC52', savedModel: 'tc501');
      expect(fromTc501.c.hasIntegratedRfid, isFalse);
      expect(fromTc501.c.prefs.deviceModel, 'tc52');
      fromTc501.c.dispose();
    });

    test('a saved profile answers before Android reports the model', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final c = AppController(
        api: FakeApi(),
        prefs: prefs,
        rfid: ProbeRfid(const {}),
      );
      prefs.deviceModel = 'tc501';
      expect(c.hasIntegratedRfid, isTrue);
      prefs.deviceModel = 'mc3390r';
      expect(c.hasIntegratedRfid, isTrue);
      prefs.deviceModel = 'tc52';
      expect(c.hasIntegratedRfid, isFalse);
      c.dispose();
    });

    test('boot and device setup share one classifier', () {
      const cases = {
        'TC52': ('tc52', false),
        'MC3390R': ('mc3390r', true),
        'TC501': ('tc501', true),
        'TC21': ('zebra', false),
      };
      for (final entry in cases.entries) {
        final profile = HandheldProfile.classify(
          model: entry.key,
          manufacturer: 'Zebra Technologies',
          brand: 'Zebra',
        );
        expect(profile.id, entry.value.$1, reason: entry.key);
        expect(profile.hasIntegratedRfid, entry.value.$2, reason: entry.key);
        expect(profile.modelKnown, isTrue, reason: entry.key);
      }
      final blank = HandheldProfile.classify(
        model: '',
        manufacturer: '',
        brand: '',
      );
      expect(blank.modelKnown, isFalse);
      expect(blank.hasIntegratedRfid, isFalse);
    });

    test('an unknown Zebra model drops a saved RFID profile immediately',
        () async {
      final h = await _boot('TC21', savedModel: 'tc501');
      expect(h.c.prefs.deviceModel, 'zebra');
      expect(h.c.hasIntegratedRfid, isFalse);
      expect(h.c.usesZebraSdk, isTrue);
      expect(h.api.heartbeats.last['name'], 'Zebra Handheld');
      expect(h.rfid.calls, isNot(contains('connect')));
      h.c.dispose();
    });

    test('heartbeat stores RFID capability with the model', () async {
      final tc52 = await _boot('TC52');
      expect(tc52.api.heartbeats.last['model'], 'tc52');
      expect(tc52.api.heartbeats.last['hasIntegratedRfid'], isFalse);
      expect(tc52.api.heartbeats.last['usesZebraSdk'], isTrue);
      tc52.c.dispose();

      final tc501 = await _boot('TC501');
      expect(tc501.api.heartbeats.last['model'], 'tc501');
      expect(tc501.api.heartbeats.last['hasIntegratedRfid'], isTrue);
      expect(tc501.api.heartbeats.last['usesZebraSdk'], isTrue);
      tc501.c.dispose();
    });

    test('a stored server profile is restored when Android has no model yet',
        () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final api = FakeApi()
        ..state = fixtureState()
        ..myDevice = {
          'model': 'tc501',
          'hasIntegratedRfid': true,
          'usesZebraSdk': true,
        };
      final c = AppController(
        api: api,
        prefs: prefs,
        rfid: ProbeRfid(const {}),
        readLanIp: () async => '192.168.1.50',
      );
      await c.refresh();
      c.wh = 'WH-1';
      c.gate = '2';
      prefs.deviceWh = 'WH-1';
      prefs.deviceGate = '2';
      prefs.deviceConfigured = true;
      prefs.token = 'device-token';
      api.token = 'device-token';
      c.emp = c.employees.firstWhere((e) => e.id == 'EMP-0001');
      await c.init();
      await Future<void>.delayed(Duration.zero);
      expect(c.prefs.deviceModel, 'tc501');
      expect(c.hasIntegratedRfid, isTrue);
      expect(c.usesZebraSdk, isTrue);
      expect(api.heartbeats.last['name'], 'Zebra TC501');
      c.dispose();
    });

    test('live hardware wins over a stored server profile', () async {
      final api = FakeApi()
        ..state = fixtureState()
        ..myDevice = {
          'model': 'tc501',
          'hasIntegratedRfid': true,
          'usesZebraSdk': true,
        };
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final c = AppController(
        api: api,
        prefs: prefs,
        rfid: ProbeRfid(_zebra('TC52')),
        readLanIp: () async => '192.168.1.50',
      );
      await c.refresh();
      c.wh = 'WH-1';
      c.gate = '2';
      prefs.deviceWh = 'WH-1';
      prefs.deviceGate = '2';
      prefs.deviceConfigured = true;
      prefs.token = 'device-token';
      api.token = 'device-token';
      c.emp = c.employees.firstWhere((e) => e.id == 'EMP-0001');
      await c.init();
      await Future<void>.delayed(Duration.zero);
      expect(c.prefs.deviceModel, 'tc52');
      expect(c.hasIntegratedRfid, isFalse);
      expect(api.heartbeats.last['model'], 'tc52');
      expect(api.heartbeats.last['hasIntegratedRfid'], isFalse);
      c.dispose();
    });

    test('a profile change updates RFID without waiting for the next launch',
        () async {
      final h = await _boot('TC52');
      expect(h.c.hasIntegratedRfid, isFalse);

      h.c.setDeviceModel('mc3390r');
      expect(h.c.hasIntegratedRfid, isTrue);
      expect(h.c.prefs.deviceModel, 'mc3390r');
      expect(h.rfid.calls, contains('connect'));
      expect(h.api.heartbeats.last['model'], 'mc3390r');
      expect(h.api.heartbeats.last['hasIntegratedRfid'], isTrue);
      h.c.goLocate();
      expect(h.c.screen, Screen.rfidLocate);
      h.c.setScanInputMode(ScanInputMode.rfid);
      expect(h.c.scanInputMode, ScanInputMode.rfid);

      h.c.setDeviceModel('tc52');
      expect(h.c.hasIntegratedRfid, isFalse);
      expect(h.c.prefs.deviceModel, 'tc52');
      expect(h.c.screen, Screen.home,
          reason: 'an open RFID screen closes when the terminal is barcode-only');
      expect(h.c.scanInputMode, ScanInputMode.barcode);
      expect(h.rfid.calls, contains('stopInventory'));
      h.c.goLocate();
      expect(h.c.screen, isNot(Screen.rfidLocate));
      h.c.dispose();
    });
  });

  group('menus and RFID mode', () {
    test('TC52 cannot open RFID screens and cannot select RFID mode',
        () async {
      final h = await _boot('TC52');
      h.c.goLocate();
      expect(h.c.screen, isNot(Screen.rfidLocate));
      h.c.go(Screen.rfidInput);
      expect(h.c.screen, isNot(Screen.rfidInput));
      h.c.go(Screen.boxRegister);
      expect(h.c.screen, isNot(Screen.boxRegister));
      h.c.goBoxRegister();
      expect(h.c.screen, isNot(Screen.boxRegister),
          reason: 'the direct register entry must honor the same RFID gate');

      h.c.goTrack();
      h.c.setScanInputMode(ScanInputMode.rfid);
      expect(h.c.scanInputMode, ScanInputMode.barcode);
      h.c.dispose();
    });

    test('MC3390R and TC501 can open RFID screens and switch mode', () async {
      for (final model in ['MC3390R', 'TC501']) {
        final h = await _boot(model);
        h.c.goLocate();
        expect(h.c.screen, Screen.rfidLocate, reason: model);
        h.c.go(Screen.rfidInput);
        expect(h.c.screen, Screen.rfidInput, reason: model);
        h.c.goBoxRegister();
        expect(h.c.screen, Screen.boxRegister, reason: model);
        h.c.goTrack();
        h.c.setScanInputMode(ScanInputMode.rfid);
        expect(h.c.scanInputMode, ScanInputMode.rfid, reason: model);
        h.c.setScanInputMode(ScanInputMode.barcode);
        expect(h.c.scanInputMode, ScanInputMode.barcode, reason: model);
        h.c.dispose();
      }
    });
  });

  group('trigger and scanner', () {
    test('TC52 queues a barcode and never starts an RFID inventory', () async {
      final h = await _boot('TC52');
      h.c.goScanIn();
      await Future<void>.delayed(Duration.zero);
      expect(h.rfid.touchedRfidTrigger, isFalse);
      expect(h.rfid.calls, contains('barcode:true'),
          reason: 'the TC52 imager stays armed on the scan screen');
      h.rfid.calls.clear();
      h.rfid.pull(true);
      await Future<void>.delayed(Duration.zero);
      expect(h.rfid.startedInventory, isFalse);
      expect(h.c.queue, isEmpty);

      h.rfid.scan('CRT-02');
      await Future<void>.delayed(Duration.zero);
      expect(h.c.queue, ['CRT-02']);
      h.c.dispose();
    });

    test('RFID handhelds inventory only while RFID mode owns the trigger',
        () async {
      for (final model in ['MC3390R', 'TC501']) {
        final h = await _boot(model);
        h.c.goScanIn();
        h.c.setScanInputMode(ScanInputMode.rfid);
        h.rfid.calls.clear();
        h.rfid.pull(true);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.startedInventory, isTrue, reason: model);
        expect(h.rfid.calls.where((c) => c.startsWith('barcode:')), isEmpty,
            reason: '$model must not also arm DataWedge');

        h.rfid.calls.clear();
        h.c.setScanInputMode(ScanInputMode.barcode);
        h.rfid.pull(true);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.startedInventory, isFalse, reason: model);
        expect(h.c.toast?.title, 'อยู่ในโหมดบาร์โค้ด');
        h.c.dispose();
      }
    });

    test('RFID trigger stays idle on the vehicle form, putaway, and home',
        () async {
      for (final model in ['MC3390R', 'TC501']) {
        final h = await _boot(model);
        h.c.goScanIn();
        h.c.setScanInputMode(ScanInputMode.rfid);
        h.c.gateFormStep = true;
        h.rfid.calls.clear();
        h.rfid.pull(true);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.startedInventory, isFalse, reason: model);
        expect(h.c.toast?.title, 'กรอกข้อมูลลูกค้า/รถให้ครบก่อน');

        h.c.gateFormStep = false;
        h.c.putawayTask = PutawayTask(
            tags: const ['CRT-02'], assigned: null, whName: 'คลัง 1');
        h.rfid.calls.clear();
        h.rfid.pull(true);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.startedInventory, isFalse, reason: model);
        expect(h.c.toast?.title, 'ยิงบาร์โค้ดชั้นวางเท่านั้น');

        h.c.putawayTask = null;
        h.c.backToHome();
        final toastBeforeHome = h.c.toast?.title;
        h.rfid.calls.clear();
        h.rfid.pull(true);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.startedInventory, isFalse, reason: model);
        expect(h.c.toast?.title, toastBeforeHome,
            reason: '$model home must not raise a new trigger alert');
        h.c.dispose();
      }
    });

    test('leaving a screen and resuming keeps that screen\'s trigger owner',
        () async {
      for (final model in ['MC3390R', 'TC501']) {
        final h = await _boot(model);
        h.c.go(Screen.settings);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.lastRfidTrigger, 'rfidTrigger:true', reason: model);

        h.c.goHoldRelease();
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.lastRfidTrigger, 'rfidTrigger:false', reason: model);

        h.c.didChangeAppLifecycleState(AppLifecycleState.resumed);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.lastRfidTrigger, 'rfidTrigger:false',
            reason: '$model resume must not hand the trigger back to RFID');

        h.c.goCycleCount();
        h.c.setScanInputMode(ScanInputMode.rfid);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.lastRfidTrigger, 'rfidTrigger:true', reason: model);
        h.c.didChangeAppLifecycleState(AppLifecycleState.resumed);
        await Future<void>.delayed(Duration.zero);
        expect(h.rfid.lastRfidTrigger, 'rfidTrigger:true', reason: model);
        h.c.dispose();
      }
    });

    test('TC52 resume keeps the barcode imager and never calls RFID mode',
        () async {
      final h = await _boot('TC52');
      h.c.goTrack();
      h.rfid.calls.clear();
      h.c.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await Future<void>.delayed(Duration.zero);
      expect(h.rfid.touchedRfidTrigger, isFalse);
      expect(h.rfid.calls, contains('barcode:true'));
      h.c.dispose();
    });
  });

  group('presence and reader connect', () {
    test('each model heartbeats under its own name', () async {
      const expected = {
        'TC52': ('Zebra TC52', 'tc52'),
        'MC3390R': ('Zebra MC3390R', 'mc3390r'),
        'TC501': ('Zebra TC501', 'tc501'),
      };
      for (final entry in expected.entries) {
        final h = await _boot(entry.key, savedModel: 'generic');
        expect(h.api.heartbeats, isNotEmpty, reason: entry.key);
        expect(h.api.heartbeats.last['name'], entry.value.$1, reason: entry.key);
        expect(h.api.heartbeats.last['model'], entry.value.$2,
            reason: entry.key);
        h.c.dispose();
      }
    });

    test('only integrated readers attempt an RFID connection', () async {
      final tc52 = await _boot('TC52');
      expect(tc52.rfid.calls, isNot(contains('connect')));
      tc52.c.dispose();

      for (final model in ['MC3390R', 'TC501']) {
        final h = await _boot(model);
        expect(h.rfid.calls, contains('connect'), reason: model);
        h.c.dispose();
      }
    });
  });

  group('on-screen menus', () {
    Future<AppController> shown(String savedModel, {bool rfid = false}) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final api = FakeApi()..state = fixtureState();
      final c = AppController(
        api: api,
        prefs: prefs,
        rfid: RfidService(),
      );
      await c.refresh();
      c.wh = 'WH-1';
      c.gate = '2';
      prefs.deviceConfigured = true;
      prefs.token = 'device-token';
      prefs.deviceModel = savedModel;
      c.debugHasIntegratedRfid = rfid;
      c.emp = c.employees.firstWhere((e) => e.id == 'EMP-0001');
      return c;
    }

    Widget wrap(AppController c, Widget screen, {bool theme = false}) {
      return MultiProvider(
        providers: [
          ChangeNotifierProvider<AppController>.value(value: c),
          ChangeNotifierProvider<LocaleController>.value(
              value: LocaleController(c.prefs)),
          if (theme)
            ChangeNotifierProvider<ThemeController>.value(
                value: ThemeController(c.prefs)),
        ],
        child: MaterialApp(home: Scaffold(body: screen)),
      );
    }

    testWidgets('radar and the track RFID toggle follow the handheld',
        (tester) async {
      final tc52 = await shown('tc52');
      await tester.pumpWidget(wrap(tc52, const MoreHubScreen()));
      await tester.pump();
      expect(find.text('ค้นหา/เรดาร์'), findsNothing);
      await tester.pumpWidget(wrap(tc52, const TrackScreen()));
      await tester.pump();
      expect(find.text('RFID'), findsNothing);
      tc52.dispose();

      for (final model in ['mc3390r', 'tc501']) {
        final c = await shown(model);
        await tester.pumpWidget(wrap(c, const MoreHubScreen()));
        await tester.pump();
        expect(find.text('ค้นหา/เรดาร์'), findsOneWidget, reason: model);
        await tester.pumpWidget(wrap(c, const TrackScreen()));
        await tester.pump();
        expect(find.text('RFID'), findsOneWidget, reason: model);
        c.dispose();
      }
    });

    testWidgets('settings hides RFID controls on TC52 and shows them on readers',
        (tester) async {
      final tc52 = await shown('tc52');
      await tester.pumpWidget(wrap(tc52, const SettingsScreen(), theme: true));
      await tester.pump();
      expect(find.textContaining('เครื่องอ่าน RFID'), findsNothing);
      expect(find.text('รับค่า RFID'), findsNothing);
      tc52.dispose();

      for (final model in ['mc3390r', 'tc501']) {
        final c = await shown(model);
        await tester.pumpWidget(wrap(c, const SettingsScreen(), theme: true));
        await tester.pump();
        expect(find.textContaining('เครื่องอ่าน RFID'), findsOneWidget,
            reason: model);
        await tester.drag(find.byType(ListView).first, const Offset(0, -900));
        await tester.pumpAndSettle();
        expect(find.text('รับค่า RFID'), findsOneWidget, reason: model);
        c.dispose();
      }
    });
  });

  group('device setup profile', () {
    Future<void> expectProfile(
      WidgetTester tester, {
      required String model,
      required String title,
      required bool hasRfid,
      required String savedId,
    }) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      const channel = MethodChannel('smarttrace/rfid');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'deviceInfo') return _zebra(model);
        return null;
      });
      try {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final c = AppController(
        api: FakeApi()..state = fixtureState(),
        prefs: prefs,
        rfid: RfidService(),
      );
      await c.refresh();
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AppController>.value(value: c),
            ChangeNotifierProvider<LocaleController>.value(
                value: LocaleController(c.prefs)),
            ChangeNotifierProvider<ThemeController>.value(
                value: ThemeController(c.prefs)),
          ],
          child: const MaterialApp(home: Scaffold(body: DeviceSetupScreen())),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text(title), findsOneWidget, reason: model);
      expect(c.prefs.deviceModel, savedId, reason: model);
      if (hasRfid) {
        expect(
          find.text('ใช้ Zebra SDK ได้: สแกนบาร์โค้ด, อ่าน/เขียน RFID และค้นหาแท็ก'),
          findsOneWidget,
        );
      } else {
        expect(find.textContaining('RFID ในตัวเครื่องใช้ไม่ได้'), findsOneWidget);
      }
      c.dispose();
      } finally {
        debugDefaultTargetPlatformOverride = null;
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      }
    }

    testWidgets('TC52 setup stays barcode-only', (tester) async {
      await expectProfile(tester,
          model: 'TC52',
          title: 'Zebra TC52',
          hasRfid: false,
          savedId: 'tc52');
    });

    testWidgets('MC3390R setup enables integrated RFID', (tester) async {
      await expectProfile(tester,
          model: 'MC3390R',
          title: 'Zebra MC3300 Series (MC3390R)',
          hasRfid: true,
          savedId: 'mc3390r');
    });

    testWidgets('TC501 setup enables integrated RFID', (tester) async {
      await expectProfile(tester,
          model: 'TC501',
          title: 'Zebra TC501',
          hasRfid: true,
          savedId: 'tc501');
    });

    testWidgets('a blank Android report keeps a saved TC501 profile',
        (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      const channel = MethodChannel('smarttrace/rfid');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (_) async => null);
      try {
        SharedPreferences.setMockInitialValues({});
        final prefs = await Prefs.load();
        final c = AppController(
          api: FakeApi()..state = fixtureState(),
          prefs: prefs,
          rfid: RfidService(),
        );
        await c.refresh();
        c.prefs.deviceModel = 'tc501';
        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider<AppController>.value(value: c),
              ChangeNotifierProvider<LocaleController>.value(
                  value: LocaleController(c.prefs)),
              ChangeNotifierProvider<ThemeController>.value(
                  value: ThemeController(c.prefs)),
            ],
            child: const MaterialApp(home: Scaffold(body: DeviceSetupScreen())),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.text('Zebra TC501'), findsOneWidget);
        expect(c.prefs.deviceModel, 'tc501');
        expect(c.hasIntegratedRfid, isTrue);
        c.dispose();
      } finally {
        debugDefaultTargetPlatformOverride = null;
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      }
    });
  });
}
