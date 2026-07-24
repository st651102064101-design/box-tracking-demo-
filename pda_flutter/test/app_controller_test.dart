import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:boxtrace_pda/controllers/app_controller.dart';
import 'package:boxtrace_pda/services/api_client.dart';
import 'package:boxtrace_pda/services/prefs.dart';
import 'package:boxtrace_pda/services/rfid_service.dart';

/// Records what the controller sends instead of hitting the network.
class FakeApi extends ApiClient {
  FakeApi() : super(baseUrl: 'http://test');

  Map<String, dynamic> state = {};
  List<Map<String, dynamic>> usersFixture = [];
  final List<Map<String, dynamic>> gateInCalls = [];
  final List<Map<String, dynamic>> gateOutCalls = [];
  final List<String> loginCalls = [];

  /// When set, the next gate call throws this instead of succeeding.
  Object? throwOnGate;

  /// username -> error message; if present, login() for that username throws
  /// an ApiException(401, message) instead of succeeding — simulates a wrong
  /// password without needing a real backend.
  final Map<String, String> failLoginFor = {};

  @override
  Future<Map<String, dynamic>> login(String u, String p) async {
    loginCalls.add(u);
    if (failLoginFor.containsKey(u)) {
      throw ApiException(401, failLoginFor[u]!);
    }
    final match = usersFixture.firstWhere(
      (row) => row['username'] == u,
      orElse: () => {'name': u},
    );
    return {
      'token': 'token-for-$u',
      'user': {'id': 1, 'username': u, 'name': match['name'] ?? u, 'role': match['role'] ?? 'staff'},
    };
  }

  @override
  Future<List<Map<String, dynamic>>> listUsers() async => usersFixture;

  @override
  Future<Map<String, dynamic>> getState() async => state;

  @override
  Future<void> putState(Map<String, dynamic> s) async {
    state = s;
  }

  @override
  Future<Map<String, dynamic>> gateIn({
    required List<String> tags,
    required int gate,
    String? recorder,
  }) async {
    if (throwOnGate != null) {
      final e = throwOnGate!;
      throwOnGate = null;
      throw e;
    }
    gateInCalls.add({'tags': tags, 'gate': gate, 'recorder': recorder});
    return {'ok': true, 'received': tags, 'unknown': <String>[], 'count': tags.length};
  }

  @override
  Future<Map<String, dynamic>> gateOut({
    required List<String> tags,
    required String customer,
    required int gate,
    String? doNo,
    String? po,
    String? recorder,
  }) async {
    if (throwOnGate != null) {
      final e = throwOnGate!;
      throwOnGate = null;
      throw e;
    }
    gateOutCalls.add({'tags': tags, 'customer': customer, 'gate': gate, 'recorder': recorder});
    return {'ok': true, 'doNo': 'DO-TEST', 'shipped': tags, 'count': tags.length};
  }
}

Map<String, dynamic> box(String tag, String status, {List<dynamic>? history, int cycles = 0}) => {
      'tag': tag,
      'type': 'BT-CRT',
      'status': status,
      'cycles': cycles,
      'customer': '',
      'do': '',
      'history': history ?? <dynamic>[],
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
      'events': <dynamic>[],
      'cfg': {'agingDays': 15},
    };

/// Employee/operator accounts, as returned by GET /api/auth/users — an
/// account IS a login now, not a separate master-data record.
List<Map<String, dynamic>> fixtureUsers() => [
      {'id': 1, 'username': 'somsri', 'name': 'สมศรี ทองดี', 'role': 'หัวหน้าคลัง', 'dept': 'คลังสินค้า'},
    ];

Future<AppController> makeController(FakeApi api) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await Prefs.load();
  final c = AppController(api: api, prefs: prefs, rfid: RfidService());
  api.state = fixtureState();
  if (api.usersFixture.isEmpty) api.usersFixture = fixtureUsers();
  await c.refresh();
  c.users = List.of(api.usersFixture);
  c.user = 'สมศรี ทองดี';
  c.wh = 'WH-1';
  c.gate = '2';
  return c;
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

    test('recovers a tag typed with a Thai keyboard layout', () async {
      final c = await makeController(FakeApi());
      c.mode = 'out';
      // 'ฆiu-01' is not it — CRT on a Thai layout is พ(r) ... use the real map:
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
    test('inbound posts the queue to /gate/in and clears it', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      c.addScan('CRT-02');
      c.addScan('CRT-03');
      await c.doCommit();

      expect(api.gateInCalls, hasLength(1));
      expect(api.gateInCalls.first['tags'], ['CRT-02', 'CRT-03']);
      expect(api.gateInCalls.first['gate'], 2);
      expect(api.gateInCalls.first['recorder'], 'สมศรี ทองดี');
      expect(c.queue, isEmpty);
    });

    test('outbound requires a customer', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'out';
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
      c.addScan('CRT-01');
      c.setOutCustomer('CUST-01');
      await c.doCommit();

      expect(api.gateOutCalls, hasLength(1));
      expect(api.gateOutCalls.first['customer'], 'CUST-01');
      expect(api.gateOutCalls.first['tags'], ['CRT-01']);
      expect(c.queue, isEmpty);
      expect(c.outCustomer, isEmpty);
    });
  });

  group('offline outbox', () {
    test('offline commit queues instead of posting, and persists', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
      c.addScan('CRT-02');
      c.online = false;
      await c.doCommit();

      expect(api.gateInCalls, isEmpty);
      expect(c.outbox, hasLength(1));
      expect(c.outbox.first.tags, ['CRT-02']);
      expect(c.prefs.outbox, hasLength(1), reason: 'must survive an app restart');
      expect(c.queue, isEmpty);
    });

    test('going back online flushes the outbox', () async {
      final api = FakeApi();
      final c = await makeController(api);
      c.mode = 'in';
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
      c.addScan('CRT-02');
      api.throwOnGate = ApiException(404, 'ไม่พบกล่อง');
      await c.doCommit();

      expect(c.outbox, isEmpty);
      expect(c.toast!.kind, ResultKind.err);
      expect(c.toast!.sub, 'ไม่พบกล่อง');
      expect(c.queue, ['CRT-02'], reason: 'operator can retry or fix the batch');
    });
  });

  group('navigation', () {
    test('leaving settings returns to login when no shift is active', () async {
      final c = await makeController(FakeApi());
      c.user = '';
      c.wh = '';
      c.gate = '';
      c.go(Screen.settings);
      c.backToHome();
      expect(c.screen, Screen.login);
    });

    test('leaving settings returns to home during a shift', () async {
      final c = await makeController(FakeApi());
      c.go(Screen.settings);
      c.backToHome();
      expect(c.screen, Screen.home);
    });

    test('startShift refuses without a gate', () async {
      final c = await makeController(FakeApi());
      c.gate = '';
      c.startShift();
      expect(c.screen, isNot(Screen.home));
      expect(c.toast!.title, 'เลือกคลังและประตูก่อน');
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

    test('a gate missing from gateTypes is simply absent, not defaulted here — the UI layer treats that as both', () async {
      final c = await makeController(FakeApi());
      expect(c.S!.gateTypesOf('WH-1').containsKey('99'), isFalse);
    });
  });

  group('employee login', () {
    test('a correct password authenticates as that employee and moves on to session setup', () async {
      final api = FakeApi()..usersFixture = fixtureUsers();
      final c = await makeController(api);
      c.screen = Screen.login;
      c.user = '';
      // makeController pre-seeds wh/gate for the other tests' convenience —
      // reset to a genuine fresh-login state for this one.
      c.wh = '';
      c.gate = '';

      final err = await c.loginAsEmployee('somsri', 'correct-horse');

      expect(err, isNull);
      expect(c.screen, Screen.session);
      expect(c.user, 'สมศรี ทองดี');
      expect(c.prefs.token, 'token-for-somsri');
      // Only one warehouse exists (WH-1) so it's auto-filled even though the
      // session screen still shows — there are 3 gates, so that choice
      // remains genuinely ambiguous and is left for the operator.
      expect(c.wh, 'WH-1');
      expect(c.gate, isEmpty);
    });

    test('a wrong password surfaces an error and never enters session setup', () async {
      final api = FakeApi()..usersFixture = fixtureUsers();
      api.failLoginFor['somsri'] = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
      final c = await makeController(api);
      c.screen = Screen.login;
      c.user = '';

      final err = await c.loginAsEmployee('somsri', 'wrong');

      expect(err, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      expect(c.screen, Screen.login);
      expect(c.user, isEmpty);
    });

    test('logout clears the operator and re-bootstraps the employee list for the next person', () async {
      final api = FakeApi()..usersFixture = fixtureUsers();
      final c = await makeController(api);
      expect(c.user, isNotEmpty);

      await c.doLogout();

      expect(c.screen, Screen.login);
      expect(c.user, isEmpty);
      expect(c.wh, isEmpty);
      expect(c.gate, isEmpty);
      expect(c.users, isNotEmpty, reason: 're-bootstrap must refetch the list, not just clear it');
    });
  });

  group('single-option auto-select', () {
    // Deliberately not using makeController() here — it hard-codes WH-1 with
    // 3 gates and pre-sets wh/gate, which would defeat exactly what these
    // tests need to control.
    Future<AppController> controllerWithState(Map<String, dynamic> state) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final api = FakeApi()
        ..state = state
        ..usersFixture = fixtureUsers();
      final c = AppController(api: api, prefs: prefs, rfid: RfidService());
      await c.refresh();
      c.users = List.of(api.usersFixture);
      return c;
    }

    Map<String, dynamic> baseState(Map<String, dynamic> warehouses, Map<String, dynamic> gates) => {
          'boxes': {},
          'customers': {},
          'boxtypes': {},
          'warehouses': warehouses,
          'gates': gates,
          'events': <dynamic>[],
          'cfg': {'agingDays': 15},
        };

    test('a single warehouse with a single gate skips session setup and starts the shift', () async {
      final c = await controllerWithState(baseState(
        {
          'WH-ONLY': {'id': 'WH-ONLY', 'name': 'คลังเดียว', 'gates': [7]}
        },
        {'7': 'WH-ONLY'},
      ));
      c.screen = Screen.login;

      final err = await c.loginAsEmployee('somsri', 'correct-horse');

      expect(err, isNull);
      expect(c.screen, Screen.home,
          reason: 'nothing to choose — should skip straight past session setup');
      expect(c.wh, 'WH-ONLY');
      expect(c.gate, '7');
    });

    test('multiple warehouses still require a real choice', () async {
      final c = await controllerWithState(baseState(
        {
          'WH-A': {'id': 'WH-A', 'name': 'คลัง A', 'gates': [1]},
          'WH-B': {'id': 'WH-B', 'name': 'คลัง B', 'gates': [2]},
        },
        {'1': 'WH-A', '2': 'WH-B'},
      ));
      c.screen = Screen.login;

      final err = await c.loginAsEmployee('somsri', 'correct-horse');

      expect(err, isNull);
      expect(c.screen, Screen.session);
      expect(c.wh, isEmpty);
      expect(c.gate, isEmpty);
    });

    test('picking a warehouse that has only one gate auto-fills that gate', () async {
      final c = await controllerWithState(baseState(
        {
          'WH-A': {'id': 'WH-A', 'name': 'คลัง A', 'gates': [1, 2]},
          'WH-B': {'id': 'WH-B', 'name': 'คลัง B (ประตูเดียว)', 'gates': [9]},
        },
        {'1': 'WH-A', '2': 'WH-A', '9': 'WH-B'},
      ));

      c.pickWh('WH-B');

      expect(c.gate, '9');
    });

    test('picking a warehouse with multiple gates still leaves the gate for the operator', () async {
      final c = await controllerWithState(baseState(
        {
          'WH-A': {'id': 'WH-A', 'name': 'คลัง A', 'gates': [1, 2]},
        },
        {'1': 'WH-A', '2': 'WH-A'},
      ));

      c.pickWh('WH-A');

      expect(c.gate, isEmpty);
    });
  });

}
