import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:boxtrace_pda/controllers/app_controller.dart';
import 'package:boxtrace_pda/models/employee.dart';
import 'package:boxtrace_pda/services/api_client.dart';
import 'package:boxtrace_pda/services/prefs.dart';
import 'package:boxtrace_pda/services/rfid_service.dart';

/// Records what the controller sends instead of hitting the network.
class FakeApi extends ApiClient {
  FakeApi() : super(baseUrl: 'http://test');

  Map<String, dynamic> state = {};
  final List<Map<String, dynamic>> gateInCalls = [];
  final List<Map<String, dynamic>> gateOutCalls = [];
  final List<String> loginCalls = [];

  /// When set, the next gate call throws this instead of succeeding.
  Object? throwOnGate;

  /// When set, getState() throws this — simulates a device that boots with the
  /// backend unreachable.
  Object? throwOnState;

  @override
  Future<Map<String, dynamic>> login(String u, String p) async {
    loginCalls.add(u);
    return {
      'token': 'token-for-$u',
      'user': {'id': 1, 'username': u, 'name': u, 'role': 'device'},
    };
  }

  @override
  Future<Map<String, dynamic>> getState() async {
    if (throwOnState != null) throw throwOnState!;
    return state;
  }

  @override
  Future<void> putState(Map<String, dynamic> s) async {
    state = s;
  }

  @override
  Future<Map<String, dynamic>> gateIn({
    required List<String> tags,
    required int gate,
    String? employeeId,
    String? recorder,
    String? plate,
    String? driver,
    String? vehicleType,
    Map<String, String>? conditions,
  }) async {
    if (throwOnGate != null) {
      final e = throwOnGate!;
      throwOnGate = null;
      throw e;
    }
    gateInCalls.add({
      'tags': tags,
      'gate': gate,
      'employeeId': employeeId,
      'recorder': recorder,
      'plate': plate,
    });
    return {'ok': true, 'received': tags, 'unknown': <String>[], 'count': tags.length};
  }

  @override
  Future<Map<String, dynamic>> gateOut({
    required List<String> tags,
    required String customer,
    required int gate,
    String? doNo,
    String? po,
    String? employeeId,
    String? recorder,
    String? plate,
    String? driver,
    String? vehicleType,
  }) async {
    if (throwOnGate != null) {
      final e = throwOnGate!;
      throwOnGate = null;
      throw e;
    }
    gateOutCalls.add({
      'tags': tags,
      'customer': customer,
      'gate': gate,
      'employeeId': employeeId,
      'recorder': recorder,
      'plate': plate,
    });
    return {'ok': true, 'doNo': 'DO-TEST', 'shipped': tags, 'count': tags.length};
  }
}

Map<String, dynamic> box(String tag, String status,
        {List<dynamic>? history, int cycles = 0, String? rfidTid, String? rfidEpc}) =>
    {
      'tag': tag,
      'type': 'BT-CRT',
      'status': status,
      'cycles': cycles,
      'customer': '',
      'do': '',
      'history': history ?? <dynamic>[],
      if (rfidTid != null) 'rfidTid': rfidTid,
      if (rfidEpc != null) 'rfidEpc': rfidEpc,
    };

/// The WMS employee master, which is the PDA's only source of people. Covers
/// the four cases the badge screen has to get right: a supervisor, a plain
/// operator, someone on leave, and someone posted to another warehouse.
Map<String, dynamic> fixtureEmployees() => {
      'EMP-0001': {
        'id': 'EMP-0001',
        'name': 'สมศรี ทองดี',
        'role': 'หัวหน้าคลัง',
        'dept': 'คลังสินค้า',
        'wh': 'WH-1',
        'scanCode': 'BADGE-001',
        'access': 'supervisor',
        'status': 'active',
      },
      'EMP-0002': {
        'id': 'EMP-0002',
        'name': 'สมชาย ใจดี',
        'role': 'พนักงานคลัง',
        'wh': 'WH-1',
        'scanCode': 'badge-002',
        'access': 'operator',
        'status': 'active',
      },
      'EMP-0003': {
        'id': 'EMP-0003',
        'name': 'วิชัย ลาพัก',
        'wh': 'WH-1',
        'scanCode': 'BADGE-003',
        'access': 'operator',
        'status': 'leave',
      },
      'EMP-0004': {
        'id': 'EMP-0004',
        'name': 'มานี ต่างคลัง',
        'wh': 'WH-2',
        'scanCode': 'BADGE-004',
        'access': 'viewer',
        'status': 'active',
      },
    };

Map<String, dynamic> fixtureState() => {
      'boxes': {
        'CRT-01': box('CRT-01', 'warehouse'),
        'CRT-02': box('CRT-02', 'out', history: [
          {'dir': 'out', 'ts': '2026-01-01T00:00:00Z'}
        ], cycles: 1),
        'CRT-03': box('CRT-03', 'pending'),
        'CRT-04': box('CRT-04', 'lost'),
        'CRT-05': box('CRT-05', 'damage'),
        'CRT-06': box('CRT-06', 'hold'),
      },
      'customers': {
        'CUST-01': {'id': 'CUST-01', 'name': 'ลูกค้าทดสอบ', 'returnDays': 15}
      },
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
      'employees': fixtureEmployees(),
      'events': <dynamic>[],
      'cfg': {'agingDays': 15},
    };

/// A provisioned device (WH-1, gate 2) with the supervisor badged in — the
/// state most tests want to start from.
Future<AppController> makeController(FakeApi api) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await Prefs.load();
  final c = AppController(api: api, prefs: prefs, rfid: RfidService());
  // Only seed the default fixture when the test hasn't supplied its own.
  if (api.state.isEmpty) api.state = fixtureState();
  await c.refresh();
  c.wh = 'WH-1';
  c.gate = '2';
  prefs.deviceWh = 'WH-1';
  prefs.deviceGate = '2';
  prefs.deviceConfigured = true; // otherwise a restart (see init()) lands back in deviceSetup
  prefs.token = 'device-token'; // already signed in as itself, as a real one is
  c.emp = c.employees.firstWhere((e) => e.id == 'EMP-0001');
  return c;
}

/// A gate commit needs a plate before it will post anything.
void fillVehicle(AppController c) {
  c.setInPlate('1กก-1234');
  c.setOutPlate('1กก-1234');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('addScan — inbound validation', () {
    test('accepts a box that is currently out (a return)', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      c.addScan('CRT-02');
      expect(c.queue, ['CRT-02']);
      expect(c.lastResult!.kind, ResultKind.ok);
      expect(c.lastResult!.msg, contains('รับคืน'));
    });

    test('accepts a pending box as a brand-new intake', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      c.addScan('CRT-03');
      expect(c.queue, ['CRT-03']);
      expect(c.lastResult!.msg, contains('กล่องใหม่'));
    });

    test('rejects a box already in the warehouse', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      c.addScan('CRT-01');
      expect(c.queue, isEmpty);
      expect(c.lastResult!.kind, ResultKind.warn);
      expect(c.lastResult!.msg, 'อยู่ในคลังอยู่แล้ว');
    });
  });

  group('addScan — outbound validation', () {
    test('accepts a warehouse box', () async {
      final c = await makeController(FakeApi());
      c.mode = 'out';
      c.addScan('CRT-01');
      expect(c.queue, ['CRT-01']);
      expect(c.lastResult!.kind, ResultKind.ok);
    });

    test('rejects out / lost / pending / hold / damage with the right message', () async {
      final c = await makeController(FakeApi());
      c.mode = 'out';
      for (final entry in {
        'CRT-02': 'ออกไปแล้ว (ยังไม่คืน)',
        'CRT-04': 'ถูกตีเป็นสูญหาย',
        'CRT-03': 'ยังไม่เคยผ่าน Gate เข้าคลัง',
        'CRT-06': 'ถูกพักการใช้งาน (Hold)',
        'CRT-05': 'สถานะชำรุด — จ่ายออกไม่ได้',
      }.entries) {
        c.addScan(entry.key);
        expect(c.queue, isEmpty, reason: entry.key);
        expect(c.lastResult!.msg, entry.value, reason: entry.key);
      }
    });
  });

  group('addScan — tag resolution & queue', () {
    test('unknown tag is rejected', () async {
      final c = await makeController(FakeApi());
      c.addScan('NOPE-99');
      expect(c.queue, isEmpty);
      expect(c.lastResult!.kind, ResultKind.err);
      expect(c.lastResult!.msg, contains('ไม่พบกล่องนี้ในระบบ'));
    });

    test('matches tags case-insensitively', () async {
      final c = await makeController(FakeApi());
      c.mode = 'out';
      c.addScan('crt-01');
      expect(c.queue, ['CRT-01']);
    });

    test('resolves a scan by RFID EPC, not just the barcode tag', () async {
      final api = FakeApi();
      final state = fixtureState();
      state['boxes']['CRT-01'] = box('CRT-01', 'warehouse',
          rfidTid: 'E28011912000708FBAD20380', rfidEpc: '000000000000424F582D3031');
      api.state = state;
      final c = await makeController(api);
      c.mode = 'out';
      c.addScan('000000000000424F582D3031');
      expect(c.queue, ['CRT-01']);
    });

    test('resolves a scan by RFID TID, case-insensitively', () async {
      final api = FakeApi();
      final state = fixtureState();
      state['boxes']['CRT-01'] = box('CRT-01', 'warehouse',
          rfidTid: 'E28011912000708FBAD20380', rfidEpc: '000000000000424F582D3031');
      api.state = state;
      final c = await makeController(api);
      c.mode = 'out';
      c.addScan('e28011912000708fbad20380');
      expect(c.queue, ['CRT-01']);
    });

    test('recovers a tag typed with a Thai keyboard layout', () async {
      final c = await makeController(FakeApi());
      c.mode = 'out';
      // C->แ, R->พ, T->ะ  =>  'แพะ-01'
      c.addScan('แพะ-01');
      expect(c.queue, ['CRT-01']);
    });

    test('scanning the same tag twice does not duplicate it', () async {
      final c = await makeController(FakeApi());
      c.mode = 'out';
      c.addScan('CRT-01');
      c.addScan('CRT-01');
      expect(c.queue, ['CRT-01']);
      expect(c.lastResult!.kind, ResultKind.info);
      expect(c.lastResult!.msg, 'อยู่ในคิวแล้ว');
    });

    test('remove and clear work', () async {
      final c = await makeController(FakeApi());
      c.mode = 'out';
      c.addScan('CRT-01');
      c.removeFromQueue('CRT-01');
      expect(c.queue, isEmpty);
      c.addScan('CRT-01');
      c.clearQueue();
      expect(c.queue, isEmpty);
      expect(c.lastResult, isNull);
    });
  });

  group('commit', () {
    test('inbound posts the queue to /gate/in with the operator attached', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      fillVehicle(c);
      c.addScan('CRT-02');
      c.addScan('CRT-03');
      await c.doCommit();

      expect(api.gateInCalls, hasLength(1));
      expect(api.gateInCalls.first['tags'], ['CRT-02', 'CRT-03']);
      expect(api.gateInCalls.first['gate'], 2);
      expect(api.gateInCalls.first['recorder'], 'สมศรี ทองดี');
      expect(api.gateInCalls.first['employeeId'], 'EMP-0001',
          reason: 'the server resolves the name from this, so it must be sent');
      expect(c.queue, isEmpty);
    });

    test('inbound commits fine without a plate — Gate In never requires one', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      c.addScan('CRT-02');
      await c.doCommit();

      expect(api.gateInCalls, hasLength(1));
      expect(api.gateInCalls.first['plate'], isEmpty);
      expect(c.queue, isEmpty);
    });

    test('outbound without a plate posts nothing and keeps the queue', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'out';
      c.setOutCustomer('CUST-01');
      c.addScan('CRT-01');
      await c.doCommit();

      expect(api.gateOutCalls, isEmpty);
      expect(c.queue, ['CRT-01']);
      expect(c.toast!.title, 'กรอกทะเบียนรถก่อน');
    });

    test('outbound requires a customer', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'out';
      fillVehicle(c);
      c.addScan('CRT-01');
      await c.doCommit();

      expect(api.gateOutCalls, isEmpty);
      expect(c.queue, ['CRT-01'], reason: 'queue must survive a rejected commit');
      expect(c.toast!.title, 'เลือกลูกค้าปลายทางก่อน');
    });

    test('outbound posts customer + gate once selected', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'out';
      fillVehicle(c);
      c.addScan('CRT-01');
      c.setOutCustomer('CUST-01');
      await c.doCommit();

      expect(api.gateOutCalls, hasLength(1));
      expect(api.gateOutCalls.first['customer'], 'CUST-01');
      expect(api.gateOutCalls.first['tags'], ['CRT-01']);
      expect(api.gateOutCalls.first['employeeId'], 'EMP-0001');
      expect(c.queue, isEmpty);
      // Only one customer is on file, so the picker has nothing to ask and
      // re-selects it for the next batch rather than blanking the form.
      expect(c.outCustomer, 'CUST-01');
    });
  });

  group('offline outbox', () {
    test('offline commit queues instead of posting, and persists', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      fillVehicle(c);
      c.addScan('CRT-02');
      c.online = false;
      await c.doCommit();

      expect(api.gateInCalls, isEmpty);
      expect(c.outbox, hasLength(1));
      expect(c.outbox.first.tags, ['CRT-02']);
      expect(c.prefs.outbox, hasLength(1), reason: 'must survive an app restart');
      expect(c.queue, isEmpty);
    });

    test('a queued batch keeps the employee who scanned it, not whoever syncs', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      fillVehicle(c);
      c.addScan('CRT-02');
      c.online = false;
      await c.doCommit();

      // Handover: someone else takes the device before connectivity returns.
      c.lock();
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-0002'));
      c.toggleOnline();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(api.gateInCalls, hasLength(1));
      expect(api.gateInCalls.first['employeeId'], 'EMP-0001');
      expect(api.gateInCalls.first['recorder'], 'สมศรี ทองดี');
    });

    test('going back online flushes the outbox', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      fillVehicle(c);
      c.addScan('CRT-02');
      c.online = false;
      await c.doCommit();

      c.toggleOnline();
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(api.gateInCalls, hasLength(1));
      expect(c.outbox, isEmpty);
      expect(c.prefs.outbox, isEmpty);
    });

    test('a network failure mid-commit falls back to the outbox, not data loss', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      fillVehicle(c);
      c.addScan('CRT-02');
      api.throwOnGate = Exception('connection reset');
      await c.doCommit();

      expect(c.outbox, hasLength(1), reason: 'the scanned batch must not vanish');
      expect(c.outbox.first.tags, ['CRT-02']);
      expect(c.queue, isEmpty);
    });

    test('an API rejection surfaces the error and keeps the queue', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      fillVehicle(c);
      c.addScan('CRT-02');
      api.throwOnGate = ApiException(404, 'ไม่พบกล่อง');
      await c.doCommit();

      expect(c.outbox, isEmpty);
      expect(c.toast!.kind, ResultKind.err);
      expect(c.toast!.sub, 'ไม่พบกล่อง');
      expect(c.queue, ['CRT-02'], reason: 'operator can retry or fix the batch');
    });
  });

  group('badge identity', () {
    test('a badge code signs that employee in and lands on Home', () async {
      final c = await makeController(FakeApi());
      c.lock();

      final err = c.identifyByScanCode('BADGE-002');

      expect(err, isNull);
      expect(c.emp!.id, 'EMP-0002');
      expect(c.user, 'สมชาย ใจดี');
      expect(c.screen, Screen.home, reason: 'no shift setup step to pass through');
    });

    test('badge codes match regardless of case', () async {
      final c = await makeController(FakeApi());
      c.lock();
      // The master stores this one lower-case; the imager reports upper.
      expect(c.identifyByScanCode('BADGE-002'), isNull);
      expect(c.emp!.id, 'EMP-0002');
    });

    test('an unknown badge is refused and nobody is signed in', () async {
      final c = await makeController(FakeApi());
      c.lock();

      final err = c.identifyByScanCode('NOT-A-BADGE');

      expect(err, 'ไม่พบบัตรนี้ในระบบ');
      expect(c.emp, isNull);
      expect(c.screen, Screen.login);
    });

    test('a box tag swept up on the badge screen is refused, not acted on', () async {
      final c = await makeController(FakeApi());
      c.lock();
      expect(c.identifyByScanCode('CRT-01'), isNotNull);
      expect(c.emp, isNull);
    });

    test('employees on leave are hidden from the list and cannot be identified', () async {
      final c = await makeController(FakeApi());
      expect(c.employees.map((e) => e.id), isNot(contains('EMP-0003')));
      expect(c.identifyByScanCode('BADGE-003'), 'ไม่พบบัตรนี้ในระบบ');
    });

    test('employees from another warehouse are listed last and flagged as visiting', () async {
      final c = await makeController(FakeApi());
      expect(c.employees.last.id, 'EMP-0004');
      expect(c.isVisiting(c.employees.last), isTrue);
      expect(c.isVisiting(c.employees.first), isFalse);
      expect(c.identifyByScanCode('BADGE-004'), isNull,
          reason: 'visiting staff work the gate, they just get a note');
    });

    test('an employee whose scanCode was never set badges in with their id', () async {
      final api = FakeApi();
      final state = fixtureState();
      (state['employees'] as Map)['EMP-0005'] = {
        'id': 'EMP-0005', 'name': 'อารีย์ ไร้บัตร', 'wh': 'WH-1', 'access': 'operator', 'status': 'active',
      };
      api.state = state;
      final c = await makeController(api);
      c.lock();

      expect(c.identifyByScanCode('EMP-0005'), isNull);
      expect(c.emp!.name, 'อารีย์ ไร้บัตร');
    });

    test('lock() ends the session but leaves the device stationed and signed in', () async {
      final c = await makeController(FakeApi());
      c.lock();

      expect(c.emp, isNull);
      expect(c.user, isEmpty);
      expect(c.screen, Screen.login);
      expect(c.wh, 'WH-1', reason: 'a handover is not a device sign-out');
      expect(c.gate, '2');
      expect(c.prefs.token, 'device-token', reason: 'the terminal stays authenticated as itself');
      expect(c.employees, isNotEmpty, reason: 'the next person needs the list immediately');
    });
  });

  group('permissions', () {
    test('a viewer may look boxes up but not open the scan screen', () async {
      final c = await makeController(FakeApi());
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-0004'));

      expect(c.canScan, isFalse);
      c.goScanIn();
      expect(c.screen, isNot(Screen.scan));
      expect(c.toast!.title, 'ไม่มีสิทธิ์บันทึก');

      c.goTrack();
      expect(c.screen, Screen.track);
    });

    test('a plain operator cannot re-point the device; a supervisor can', () async {
      final c = await makeController(FakeApi());

      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-0002'));
      expect(c.canConfigureDevice, isFalse);

      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-0001'));
      expect(c.canConfigureDevice, isTrue);
    });

    test('a locked terminal can still be reconfigured — otherwise a bad URL strands it', () async {
      final c = await makeController(FakeApi());
      c.lock();
      expect(c.canConfigureDevice, isTrue);
    });
  });

  group('device provisioning', () {
    Future<AppController> freshDevice(FakeApi api) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final c = AppController(api: api, prefs: prefs, rfid: RfidService());
      if (api.state.isEmpty) api.state = fixtureState();
      await c.refresh();
      return c;
    }

    test('an unprovisioned device boots into setup, a provisioned one into the badge screen',
        () async {
      final api = FakeApi();
      final c = await freshDevice(api);
      expect(c.deviceConfigured, isFalse);

      await c.init();
      expect(c.screen, Screen.deviceSetup);
      expect(c.wh, 'WH-1',
          reason: 'the only warehouse on file is not a choice worth asking about');

      // Warehouse/gate are no longer fixed at setup time — they're picked
      // per-visit instead (see confirmPost/pickWh/pickGate below and
      // finishDeviceSetup's own doc comment). Finishing setup here only
      // means "this terminal has a working connection and has been through
      // setup once", so it doesn't touch prefs.deviceWh/deviceGate at all.
      c.finishDeviceSetup();
      expect(c.deviceConfigured, isTrue);
      expect(c.screen, Screen.login, reason: 'setup ends at the badge screen, ready to work');

      final c2 = AppController(api: api, prefs: c.prefs, rfid: RfidService());
      await c2.init();
      expect(c2.screen, Screen.login);
    });

    test('finishing setup while already identified goes straight to home, not the badge screen',
        () async {
      final c = await freshDevice(FakeApi());
      await c.init();
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-0001'));

      c.finishDeviceSetup();
      expect(c.deviceConfigured, isTrue);
      expect(c.screen, Screen.home);
    });

    test('picking a warehouse with a single gate fills it in', () async {
      final api = FakeApi()
        ..state = {
          'boxes': {},
          'warehouses': {
            'WH-A': {'id': 'WH-A', 'name': 'คลัง A', 'gates': [1, 2]},
            'WH-B': {'id': 'WH-B', 'name': 'คลัง B', 'gates': [9]},
          },
          'gates': {'1': 'WH-A', '2': 'WH-A', '9': 'WH-B'},
          'employees': {},
          'events': <dynamic>[],
          'cfg': {'agingDays': 15},
        };
      final c = await freshDevice(api);

      c.pickWh('WH-B');
      expect(c.gate, '9');

      c.pickWh('WH-A');
      expect(c.gate, isEmpty, reason: 'two gates is a real choice');
    });

    test('no operator survives a restart — a shift always starts with a badge', () async {
      final api = FakeApi();
      final c = await makeController(api);
      expect(c.emp, isNotNull);

      final c2 = AppController(api: api, prefs: c.prefs, rfid: RfidService());
      await c2.init();

      expect(c2.emp, isNull);
      expect(c2.screen, Screen.login);
    });
  });

  group('report-screen post picker', () {
    Map<String, dynamic> pickerState() => {
          'boxes': {},
          'warehouses': {
            'WH-A': {'id': 'WH-A', 'name': 'คลัง A', 'gates': [1, 2]},
            'WH-B': {'id': 'WH-B', 'name': 'คลัง B', 'gates': [9]},
          },
          'gates': {'1': 'WH-A', '2': 'WH-A', '9': 'WH-B'},
          'employees': {
            'EMP-OP': {
              'id': 'EMP-OP',
              'name': 'ปฏิบัติการ',
              'wh': 'WH-A',
              'access': 'operator',
              'status': 'active',
            },
            'EMP-VIEW': {
              'id': 'EMP-VIEW',
              'name': 'ผู้ชม',
              'wh': 'WH-A',
              'access': 'viewer',
              'status': 'active',
            },
          },
          'events': <dynamic>[],
          'cfg': {'agingDays': 15},
        };

    Future<AppController> controllerWithState(Map<String, dynamic> state) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final c = AppController(api: FakeApi()..state = state, prefs: prefs, rfid: RfidService());
      await c.refresh();
      return c;
    }

    test('badging in with more than one warehouse on file waits for a pick', () async {
      final c = await controllerWithState(pickerState());
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));

      expect(c.postConfirmed, isFalse);
      expect(c.pendingWh, isNull);
    });

    test('badging in with one warehouse skips the warehouse picker and shows gates', () async {
      final state = pickerState();
      (state['warehouses'] as Map).remove('WH-B');
      state['gates'] = {'1': 'WH-A', '2': 'WH-A'};
      final c = await controllerWithState(state);

      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));

      expect(c.postConfirmed, isFalse);
      expect(c.pendingWh, 'WH-A');
      expect(c.wh, isEmpty);
    });

    test('picking a warehouse with one gate confirms the post immediately', () async {
      final c = await controllerWithState(pickerState());
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));

      c.selectPendingWh('WH-B');

      expect(c.postConfirmed, isTrue);
      expect(c.wh, 'WH-B');
      expect(c.gate, '9');
    });

    test('picking a warehouse with two gates waits for the gate, then confirms', () async {
      final c = await controllerWithState(pickerState());
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));

      c.selectPendingWh('WH-A');
      expect(c.postConfirmed, isFalse, reason: 'two gates is a real choice');
      expect(c.pendingWh, 'WH-A');

      c.confirmPost('WH-A', 2);
      expect(c.postConfirmed, isTrue);
      expect(c.wh, 'WH-A');
      expect(c.gate, '2');
      expect(c.pendingWh, isNull);
    });

    test('a single warehouse with a single gate skips the picker entirely', () async {
      final state = pickerState();
      (state['warehouses'] as Map).remove('WH-A');
      state['gates'] = {'9': 'WH-B'};
      final c = await controllerWithState(state);

      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));

      expect(c.postConfirmed, isTrue);
      expect(c.wh, 'WH-B');
      expect(c.gate, '9');
      expect(c.hasLastSelection, isTrue);
      expect(c.lastWh, 'WH-B');
      expect(c.lastGate, '9');
    });

    test('a viewer never has to pick a post — search is warehouse-agnostic', () async {
      final c = await controllerWithState(pickerState());
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-VIEW'));

      expect(c.postConfirmed, isTrue);
    });

    test('confirming a post is remembered as ล่าสุด and reusable via useLastPost', () async {
      final c = await controllerWithState(pickerState());
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));
      c.confirmPost('WH-A', 1);
      expect(c.hasLastSelection, isTrue);
      expect(c.lastWh, 'WH-A');
      expect(c.lastGate, '1');

      c.lock();
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));
      expect(c.postConfirmed, isFalse, reason: 'a fresh badge-in always asks again');

      c.useLastPost();
      expect(c.postConfirmed, isTrue);
      expect(c.wh, 'WH-A');
      expect(c.gate, '1');
    });

    test('useLastPost warns instead of confirming when the remembered warehouse is gone', () async {
      final c = await controllerWithState(pickerState());
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));
      c.confirmPost('WH-A', 1);

      final state2 = pickerState();
      (state2['warehouses'] as Map).remove('WH-A');
      final c2 = AppController(api: FakeApi()..state = state2, prefs: c.prefs, rfid: RfidService());
      await c2.refresh();

      c2.useLastPost();

      expect(c2.postConfirmed, isFalse);
      expect(c2.toast!.title, 'ไม่พบคลังเดิม');
    });

    test('useLastPost warns instead of confirming when the remembered gate is gone', () async {
      final c = await controllerWithState(pickerState());
      c.identifyAs(c.employees.firstWhere((e) => e.id == 'EMP-OP'));
      c.confirmPost('WH-A', 1);

      final state2 = pickerState();
      (state2['warehouses']['WH-A'] as Map)['gates'] = [2];
      state2['gates'] = {'2': 'WH-A', '9': 'WH-B'};
      final c2 = AppController(api: FakeApi()..state = state2, prefs: c.prefs, rfid: RfidService());
      await c2.refresh();

      c2.useLastPost();

      expect(c2.postConfirmed, isFalse);
      expect(c2.toast!.title, 'ไม่พบประตูเดิม');
    });
  });

  group('offline resilience', () {
    test('refresh caches the snapshot so the next boot has data', () async {
      final api = FakeApi();
      final c = await makeController(api);
      expect(c.prefs.stateCache, isNotNull);
      expect((c.prefs.stateCache!['boxes'] as Map), hasLength(6));
    });

    test('a device that boots with the backend down still lists employees and boxes', () async {
      final api = FakeApi();
      final c = await makeController(api); // primes the cache
      api.throwOnState = Exception('Failed to fetch');

      final c2 = AppController(api: api, prefs: c.prefs, rfid: RfidService());
      await c2.init();

      expect(c2.connError, isNotNull, reason: 'the failure is still reported');
      expect(c2.boxCount, 6, reason: 'but the cached snapshot keeps the device usable');
      expect(c2.employees, isNotEmpty);
      expect(c2.identifyByScanCode('BADGE-001'), isNull);
    });

    test('the API client is wired to renew an expired device token', () async {
      final api = FakeApi();
      final c = await makeController(api);
      await c.init();
      expect(api.reauthenticate, isNotNull);
      expect(await api.reauthenticate!(), isTrue);
      expect(api.loginCalls, contains('admin'));
    });
  });

  group('navigation', () {
    test('leaving settings returns to the badge screen when nobody is signed in', () async {
      final c = await makeController(FakeApi());
      c.lock();
      c.go(Screen.settings);
      c.backToHome();
      expect(c.screen, Screen.login);
    });

    test('leaving settings returns to home during a session', () async {
      final c = await makeController(FakeApi());
      c.go(Screen.settings);
      c.backToHome();
      expect(c.screen, Screen.home);
    });
  });

  group('derived stats', () {
    test('counts warehouse and out boxes', () async {
      final c = await makeController(FakeApi());
      expect(c.warehouseCount, 1);
      expect(c.outCount, 1);
      expect(c.boxCount, 6);
      expect(c.connected, isTrue);
    });
  });

  group('gate direction', () {
    test('exposes each gate\'s in/out/both classification', () async {
      final c = await makeController(FakeApi());
      final types = c.S!.gateTypesOf('WH-1');
      expect(types['1'], 'in');
      expect(types['2'], 'out');
      expect(types['3'], 'both');
    });

    test('a gate missing from gateTypes is simply absent, not defaulted here — the UI layer treats that as both',
        () async {
      final c = await makeController(FakeApi());
      expect(c.S!.gateTypesOf('WH-1').containsKey('99'), isFalse);
    });
  });

  group('Employee model', () {
    test("treats the WMS's '-' placeholder as unset", () {
      final e = Employee.fromJson({'id': 'EMP-9', 'name': 'ทดสอบ', 'dept': '-', 'role': ''});
      expect(e.dept, isEmpty);
      expect(e.subtitle, isEmpty);
    });

    test('defaults a record with no access/status to an active operator', () {
      final e = Employee.fromJson({'id': 'EMP-9', 'name': 'ทดสอบ'});
      expect(e.active, isTrue);
      expect(e.canScan, isTrue);
      expect(e.isSupervisor, isFalse);
    });

    test('an employee with no badge never matches an empty scan', () {
      final e = Employee.fromJson({'id': 'EMP-9', 'name': 'ทดสอบ'});
      expect(e.matchesCode(''), isFalse);
    });

    test('an employee with no scanCode still badges in with their id', () {
      // Records created before the WMS started defaulting scanCode — they must
      // keep working, otherwise every existing employee is locked out.
      final e = Employee.fromJson({'id': 'EMP-9', 'name': 'ทดสอบ'});
      expect(e.badgeCode, 'EMP-9');
      expect(e.matchesCode('emp-9'), isTrue);
    });
  });
}
