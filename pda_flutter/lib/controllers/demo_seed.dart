import 'dart:math';

/// Builds the demo warehouse dataset — a faithful Dart port of `doSeed()` in the
/// BoxTrace PDA mockup — so the operator can populate an empty backend straight
/// from the device (`PUT /api/state`). Produces the exact `S` shape the
/// backend's state bridge expects.
Map<String, dynamic> buildDemoState() {
  final rnd = Random();
  String pad(int n, [int w = 4]) => n.toString().padLeft(w, '0');
  String iso(DateTime d) => d.toUtc().toIso8601String();
  String ddmmyyyy(DateTime d) => '${pad(d.day, 2)}/${pad(d.month, 2)}/${d.year}';
  final now = DateTime.now();
  String ago(int days) => iso(now.subtract(Duration(days: days)));
  String due(int days, int rd) => iso(now.subtract(Duration(days: days)).add(Duration(days: rd)));

  final zones = ['A', 'B', 'C', 'D'];
  Map<String, dynamic> mkLoc(String wh, int d) => {
        'wh': wh,
        'zone': zones[rnd.nextInt(4)],
        'rack': 'R-${pad(1 + rnd.nextInt(8), 2)}',
        'shelf': '${1 + rnd.nextInt(4)}',
        'slot': pad(1 + rnd.nextInt(12), 2),
        'gate': null,
        'ts': ago(d),
      };

  final S = <String, dynamic>{
    'boxes': <String, dynamic>{},
    'customers': <String, dynamic>{},
    'boxtypes': <String, dynamic>{},
    'warehouses': <String, dynamic>{},
    'gates': <String, dynamic>{},
    'events': <dynamic>[],
    'cfg': {'agingDays': 15, 'boxValue': 450, 'lostMode': 'manual'},
    'seq': {'do': 0, 'emp': 0},
    'inventory': <String, dynamic>{},
    'auditLog': <dynamic>[],
    'vehicles': <String, dynamic>{},
    'putaway': <String, dynamic>{},
    'doRecords': <String, dynamic>{},
    'employees': <String, dynamic>{},
    'locations': <String, dynamic>{},
  };

  final boxes = S['boxes'] as Map<String, dynamic>;
  final warehouses = S['warehouses'] as Map<String, dynamic>;
  final gates = S['gates'] as Map<String, dynamic>;
  final customers = S['customers'] as Map<String, dynamic>;
  final boxtypes = S['boxtypes'] as Map<String, dynamic>;
  final events = S['events'] as List<dynamic>;
  final employees = S['employees'] as Map<String, dynamic>;
  final seq = S['seq'] as Map<String, dynamic>;

  // warehouses + gate ranges
  final whDefs = [
    ['WH-1', 'คลัง 1 — บางปู', 1, 5],
    ['WH-2', 'คลัง 2 — ลาดกระบัง', 6, 10],
    ['WH-3', 'คลัง 3 — รังสิต', 11, 15],
    ['WH-4', 'คลัง 4 — บางนา', 16, 20],
  ];
  for (final a in whDefs) {
    final gs = <int>[];
    for (int g = a[2] as int; g <= (a[3] as int); g++) {
      gs.add(g);
    }
    warehouses[a[0] as String] = {'id': a[0], 'name': a[1], 'gates': gs};
  }
  warehouses.forEach((_, w) {
    for (final g in (w['gates'] as List)) {
      gates['$g'] = w['id'];
    }
  });

  // customers
  final custDefs = [
    ['CUST-01', 'บจก. เอเชีย ฟู้ดส์', 'นิคมฯ บางปู', '02-111-2222', 15],
    ['CUST-02', 'บจก. ปลายทางโลจิสติกส์', 'ลาดกระบัง', '02-333-4444', 7],
    ['CUST-03', 'ห้างค้าปลีกกรุงเทพ', 'รามอินทรา', '02-555-6666', 30],
  ];
  for (final a in custDefs) {
    customers[a[0] as String] = {
      'id': a[0],
      'name': a[1],
      'addr': a[2],
      'contact': a[3],
      'returnDays': a[4],
    };
  }

  // box types
  final types = [
    ['BT-CRT', 'ลังพลาสติก 60L', 450, 'CRT'],
    ['BT-TOTE', 'กล่องโทเทอ 30L', 320, 'TOTE'],
    ['BT-PLT', 'พาเลทบ็อกซ์', 1850, 'PLT'],
  ];
  for (final t in types) {
    boxtypes[t[0] as String] = {'id': t[0], 'name': t[1], 'unit': 'ใบ', 'value': t[2]};
  }

  final recorders = ['สมศรี', 'วิไล', 'อนันต์', 'ปริม', 'ธนา'];
  final whs = ['WH-1', 'WH-2', 'WH-3', 'WH-4'];

  for (int ti = 0; ti < types.length; ti++) {
    final t = types[ti];
    final pre = '${t[3]}-';
    final val = t[2];
    final typeId = t[0];

    // 1) plain warehouse box
    final tag1 = '$pre${pad(1, 2)}';
    final wh1 = whs[ti];
    boxes[tag1] = {
      'tag': tag1, 'type': typeId, 'value': val, 'status': 'warehouse', 'cycles': 0,
      'customer': '', 'do': '', 'po': '', 'outGate': null, 'outWh': '', 'outAt': null,
      'dueAt': null, 'location': mkLoc(wh1, 30), 'lastSeenAt': ago(30), 'labeled': true,
      'history': [
        {'dir': 'reg', 'ts': ago(35), 'wh': wh1, 'loc': null, 'recorder': recorders[ti]}
      ],
    };

    // 2) shipped out (returned once before)
    seq['do'] = (seq['do'] as int) + 1;
    final do2 = 'DO-${pad(seq['do'] as int)}';
    final po2 = 'PO-2026-${pad(ti * 10 + 2, 3)}';
    final tag2 = '$pre${pad(2, 2)}';
    final wh2 = whs[(ti + 1) % 4];
    const rd2 = 15;
    boxes[tag2] = {
      'tag': tag2, 'type': typeId, 'value': val, 'status': 'out', 'cycles': 1,
      'customer': 'CUST-01', 'do': do2, 'po': po2, 'outGate': ti * 5 + 1, 'outWh': wh2,
      'outAt': ago(2), 'dueAt': due(2, rd2),
      'dueDate': ddmmyyyy(DateTime.parse(due(2, rd2))), 'returnDays': rd2, 'lastSeenAt': ago(2),
      'labeled': true,
      'history': [
        {'dir': 'reg', 'ts': ago(60), 'wh': wh2, 'loc': null, 'recorder': recorders[0]},
        {'dir': 'in', 'ts': ago(30), 'wh': wh2, 'loc': mkLoc(wh2, 30), 'recorder': recorders[0]},
        {'dir': 'out', 'ts': ago(2), 'do': do2, 'po': po2, 'customer': 'CUST-01', 'gate': ti * 5 + 1,
          'wh': wh2, 'plate': '82-1234 กทม', 'driver': 'นายสมชาย ใจดี', 'recorder': recorders[1], 'dueAt': due(2, rd2)},
      ],
    };
    events.add({'ts': ago(30), 'dir': 'in', 'tag': tag2, 'type': typeId, 'customer': '', 'gate': ti * 5 + 1, 'wh': wh2, 'recorder': recorders[0]});
    events.add({'ts': ago(2), 'dir': 'out', 'tag': tag2, 'type': typeId, 'do': do2, 'po': po2, 'customer': 'CUST-01', 'customerName': 'บจก. เอเชีย ฟู้ดส์', 'gate': ti * 5 + 1, 'wh': wh2, 'plate': '82-1234 กทม', 'driver': 'นายสมชาย ใจดี', 'recorder': recorders[1]});

    // 3) shipped out, never returned
    seq['do'] = (seq['do'] as int) + 1;
    final do3 = 'DO-${pad(seq['do'] as int)}';
    final po3 = 'PO-2026-${pad(ti * 10 + 3, 3)}';
    final tag3 = '$pre${pad(3, 2)}';
    final wh3 = whs[(ti + 2) % 4];
    const rd3 = 7;
    boxes[tag3] = {
      'tag': tag3, 'type': typeId, 'value': val, 'status': 'out', 'cycles': 0,
      'customer': 'CUST-02', 'do': do3, 'po': po3, 'outGate': ti * 5 + 2, 'outWh': wh3,
      'outAt': ago(12), 'dueAt': due(12, rd3),
      'dueDate': ddmmyyyy(DateTime.parse(due(12, rd3))), 'returnDays': rd3, 'lastSeenAt': ago(12),
      'labeled': true,
      'history': [
        {'dir': 'reg', 'ts': ago(20), 'wh': wh3, 'loc': null, 'recorder': recorders[2]},
        {'dir': 'out', 'ts': ago(12), 'do': do3, 'po': po3, 'customer': 'CUST-02', 'gate': ti * 5 + 2,
          'wh': wh3, 'plate': '70-5678 สป', 'driver': 'นายวิชัย ขยัน', 'recorder': recorders[2], 'dueAt': due(12, rd3)},
      ],
    };
    events.add({'ts': ago(12), 'dir': 'out', 'tag': tag3, 'type': typeId, 'do': do3, 'po': po3, 'customer': 'CUST-02', 'customerName': 'บจก. ปลายทางโลจิสติกส์', 'gate': ti * 5 + 2, 'wh': wh3, 'plate': '70-5678 สป', 'driver': 'นายวิชัย ขยัน', 'recorder': recorders[2]});

    // 4) returned recently, back in warehouse (2 cycles)
    final tag4 = '$pre${pad(4, 2)}';
    final wh4 = whs[(ti + 3) % 4];
    boxes[tag4] = {
      'tag': tag4, 'type': typeId, 'value': val, 'status': 'warehouse', 'cycles': 2,
      'customer': '', 'do': '', 'po': '', 'outGate': null, 'outWh': '', 'outAt': null, 'dueAt': null,
      'location': mkLoc(wh4, 0), 'lastSeenAt': ago(0), 'labeled': true,
      'history': [
        {'dir': 'reg', 'ts': ago(50), 'wh': wh4, 'loc': null, 'recorder': recorders[3]},
        {'dir': 'out', 'ts': ago(20), 'do': 'DO-0000', 'po': 'PO-2025-888', 'customer': 'CUST-03', 'gate': ti * 5 + 3,
          'wh': wh4, 'plate': '55-9012 ปท', 'driver': 'นายมานพ ตรงเวลา', 'recorder': recorders[3]},
        {'dir': 'in', 'ts': ago(3), 'wh': wh4, 'loc': mkLoc(wh4, 3), 'recorder': recorders[4]},
      ],
    };
    events.add({'ts': ago(3), 'dir': 'in', 'tag': tag4, 'type': typeId, 'customer': 'CUST-03', 'customerName': 'ห้างค้าปลีกกรุงเทพ', 'gate': ti * 5 + 3, 'wh': wh4, 'recorder': recorders[4]});

    // 5) lost
    final tag5 = '$pre${pad(5, 2)}';
    final wh5 = whs[ti];
    boxes[tag5] = {
      'tag': tag5, 'type': typeId, 'value': val, 'status': 'lost', 'cycles': 1,
      'customer': 'CUST-01', 'do': 'DO-LOST', 'po': 'PO-2025-LOST', 'outGate': ti * 5 + 4, 'outWh': wh5,
      'outAt': ago(60), 'dueAt': due(60, 15), 'lastSeenAt': ago(60), 'lostAt': ago(10), 'lostReason': 'manual', 'labeled': true,
      'history': [
        {'dir': 'reg', 'ts': ago(70), 'wh': wh5, 'loc': null, 'recorder': recorders[0]},
        {'dir': 'out', 'ts': ago(60), 'do': 'DO-LOST', 'po': 'PO-2025-LOST', 'customer': 'CUST-01', 'gate': ti * 5 + 4, 'wh': wh5, 'recorder': recorders[0]},
        {'dir': 'lost', 'ts': ago(10), 'customer': 'CUST-01', 'do': 'DO-LOST', 'reason': 'ตีสูญหาย (Manual)'},
      ],
    };
  }

  // employees (used as the login operator picker)
  final empDefs = [
    ['EMP-001', 'สมศรี ทองดี', 'หัวหน้าคลัง', 'admin'],
    ['EMP-002', 'วิไล แสนสุข', 'พนักงานคลัง', 'staff'],
    ['EMP-003', 'อนันต์ ชูใจ', 'พนักงานคลัง', 'staff'],
    ['EMP-004', 'ปริม ใจงาม', 'ธุรการคลัง', 'staff'],
  ];
  for (final e in empDefs) {
    employees[e[0] as String] = {
      'id': e[0], 'name': e[1], 'role': e[2], 'dept': 'คลังสินค้า',
      'wh': '', 'shift': '', 'phone': '', 'email': '', 'startDate': '',
      'scanCode': '', 'access': e[3], 'status': 'active',
    };
  }

  events.sort((a, b) =>
      DateTime.parse(a['ts'].toString()).compareTo(DateTime.parse(b['ts'].toString())));

  return S;
}
