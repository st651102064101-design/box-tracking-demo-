import 'dart:async';
import 'dart:math';
import 'package:flutter/foundation.dart';

import '../models/box.dart';
import '../models/employee.dart';
import '../models/outbox_tx.dart';
import '../models/state_snapshot.dart';
import '../services/api_client.dart';
import '../services/prefs.dart';
import '../services/rfid_service.dart';

enum Screen { boot, deviceSetup, login, home, scan, track, settings }

enum ResultKind { ok, err, warn, info }

class ScanResult {
  final ResultKind kind;
  final String tag;
  final String msg;
  const ScanResult(this.kind, this.tag, this.msg);
}

class Toast {
  final String title;
  final String sub;
  final ResultKind kind;
  const Toast(this.title, this.sub, this.kind);
}

/// The single orchestrator for the whole PDA app — a Dart port of the mockup's
/// `Component`, backed by the real BoxTrace REST API and the Zebra reader.
///
/// Identity is split in two on purpose:
///
///  * The **device** authenticates, once, with a service account stored in
///    [Prefs] and stays signed in for good. It is also what fixes the warehouse
///    and gate — a terminal lives at one door, so nobody re-picks that daily.
///  * The **operator** is a row of the WMS employee master ([Employee]) chosen
///    by scanning their badge. There is no account and no password behind it,
///    so people are managed entirely from the web app's "พนักงาน" page.
class AppController extends ChangeNotifier {
  final ApiClient api;
  final Prefs prefs;
  final RfidService rfid;

  AppController({required this.api, required this.prefs, required this.rfid});

  // ── screen + shift ──────────────────────────────────────────────────────
  Screen screen = Screen.boot;
  StateSnapshot? S;

  /// The operator currently holding the device — null whenever it is locked.
  Employee? emp;

  /// Display name of [emp]; kept as a plain string because it is what gets
  /// written to `recorder` and shown in every header.
  String get user => emp?.name ?? '';

  String wh = '';
  String gate = '';

  // ── scanning ────────────────────────────────────────────────────────────
  String mode = 'in'; // 'in' | 'out'
  final List<String> queue = [];
  String scanVal = '';
  ScanResult? lastResult;

  // out form
  String outCustomer = '';
  String outPlate = '';
  String outDriver = '';
  String outVehicleType = '';
  String outVehicleTypeOther = '';
  String inNote = '';

  // in form (vehicle info)
  String inPlate = '';
  String inDriver = '';
  String inVehicleType = '';
  String inVehicleTypeOther = '';

  // ── connectivity / offline ──────────────────────────────────────────────
  bool online = true;
  final List<OutboxTx> outbox = [];

  // ── track ───────────────────────────────────────────────────────────────
  String trackVal = '';
  String trackTag = '';
  bool trackTried = false;

  // ── settings ────────────────────────────────────────────────────────────
  RfidStatus rfidStatus = const RfidStatus(RfidState.idle, '');
  String? connError;
  bool busy = false;

  Toast? toast;
  Timer? _toastTimer;
  final _rnd = Random();
  StreamSubscription? _tagSub, _trigSub, _statusSub;

  // ═══════════════════════ lifecycle ═══════════════════════════════════════
  Future<void> init() async {
    api.baseUrl = prefs.baseUrl;
    api.token = prefs.token;
    api.reauthenticate = _deviceLogin;

    // Restore the last known warehouse state *before* touching the network:
    // a terminal that boots with the backend unreachable still needs employee
    // names on the badge screen and box data for the scanner. Without this the
    // whole app is dead until connectivity returns.
    final cached = prefs.stateCache;
    if (cached != null) S = StateSnapshot.fromJson(cached);

    outbox
      ..clear()
      ..addAll(prefs.outbox.map((e) => OutboxTx.fromJson(Map<String, dynamic>.from(e))));

    wh = prefs.deviceWh;
    gate = prefs.deviceGate;

    // wire the Zebra reader
    _tagSub = rfid.tags.listen(_onReaderTag);
    _trigSub = rfid.triggers.listen(_onReaderTrigger);
    _statusSub = rfid.status.listen((s) {
      rfidStatus = s;
      notifyListeners();
    });

    // Auth + state load runs alongside the splash so a slow or unreachable
    // backend never holds the UI hostage — screens render, then fill in.
    final loading = _ensureAuthAndState();
    await Future.delayed(const Duration(milliseconds: 420));

    // No operator is ever restored: a shift always starts with a badge scan,
    // which takes a second and can't mis-attribute the next person's work.
    screen = deviceConfigured ? Screen.login : Screen.deviceSetup;
    if (deviceConfigured) _connectReader();
    _startIdleWatch();
    notifyListeners();

    await loading; // never throws — errors land in connError
    notifyListeners();
  }

  /// Signs in with the terminal's own service credentials. Also used as
  /// [ApiClient.reauthenticate], so an expired token mid-shift is renewed
  /// transparently instead of failing an operator's commit.
  Future<bool> _deviceLogin() async {
    final r = await api.login(prefs.username, prefs.password);
    final token = r['token'] as String?;
    prefs.token = token;
    return token != null && token.isNotEmpty;
  }

  /// Ensures the device is authenticated and the state snapshot is current.
  Future<void> _ensureAuthAndState() async {
    try {
      if (api.token == null || api.token!.isEmpty) await _deviceLogin();
      await refresh();
      connError = null;
    } on ApiException catch (e) {
      // A stale token normally self-heals inside ApiClient; this covers the
      // case where the *stored* token was rejected before any retry could run.
      if (e.status == 401) {
        try {
          await _deviceLogin();
          await refresh();
          connError = null;
          return;
        } catch (e2) {
          connError = _msg(e2);
        }
      } else {
        connError = e.message;
      }
    } catch (e) {
      connError = _msg(e);
    }
  }

  Future<void> refresh() async {
    final json = await api.getState();
    S = StateSnapshot.fromJson(json);
    prefs.stateCache = json;
    notifyListeners();
  }

  /// Human-readable message for an arbitrary error. Strips the leading
  /// `SomethingException: ` that Dart prepends — matching only at the start so
  /// `ClientException: Failed to fetch` doesn't get mangled into `ClientFailed`.
  String _msg(Object e) {
    if (e is ApiException) return e.message;
    final s = e.toString();
    final m = RegExp(r'^[A-Za-z_]*(Exception|Error): ').firstMatch(s);
    return m == null ? s : s.substring(m.end);
  }

  @override
  void dispose() {
    _toastTimer?.cancel();
    _idleTimer?.cancel();
    _tagSub?.cancel();
    _trigSub?.cancel();
    _statusSub?.cancel();
    super.dispose();
  }

  // ═══════════════════════ helpers (mirror desktop) ════════════════════════
  String pad(int n, [int w = 4]) => n.toString().padLeft(w, '0');
  String _dstr(DateTime d) => '${d.year}-${pad(d.month, 2)}-${pad(d.day, 2)}';
  String _hms(DateTime d) => '${pad(d.hour, 2)}${pad(d.minute, 2)}${pad(d.second, 2)}';
  String genDocNo(String p) => '$p-${_dstr(DateTime.now())}-${_hms(DateTime.now())}';

  String fmtTs(String? s) {
    if (s == null || s.isEmpty) return '-';
    final d = DateTime.tryParse(s);
    if (d == null) return '-';
    final l = d.toLocal();
    return '${pad(l.day, 2)}/${pad(l.month, 2)}/${l.year} ${pad(l.hour, 2)}:${pad(l.minute, 2)}';
  }

  bool _looksThaiGarbled(String t) => RegExp(r'[฀-๿]').hasMatch(t);

  // Thai-keyboard → Latin fallback (physical scanners sometimes emit Thai)
  static const _thaiMap = {
    'ๅ': '1', '/': '2', 'ภ': '4', 'ถ': '5', 'ุ': '6', 'ึ': '7', 'ค': '8', 'ต': '9', 'จ': '0',
    'ๆ': 'q', 'ไ': 'w', 'ำ': 'e', 'พ': 'r', 'ะ': 't', 'ั': 'y', 'ี': 'u', 'ร': 'i', 'น': 'o', 'ย': 'p',
    'ฟ': 'a', 'ห': 's', 'ก': 'd', 'ด': 'f', 'เ': 'g', '้': 'h', '่': 'j', 'า': 'k', 'ส': 'l',
    'ผ': 'z', 'ป': 'x', 'แ': 'c', 'อ': 'v', 'ิ': 'b', 'ื': 'n', 'ท': 'm',
  };
  String _dethaify(String t) {
    final sb = StringBuffer();
    for (final ch in t.split('')) {
      sb.write(_thaiMap[ch] ?? ch);
    }
    return sb.toString().toUpperCase();
  }

  String resolveTag(String raw) {
    final s = S;
    if (raw.isEmpty || s == null) return raw;
    if (s.boxesRaw.containsKey(raw)) return raw;
    final up = raw.toUpperCase();
    if (s.boxesRaw.containsKey(up)) return up;
    final lo = raw.toLowerCase();
    final f = s.boxesRaw.keys.where((k) => k.toLowerCase() == lo);
    if (f.isNotEmpty) return f.first;
    if (_looksThaiGarbled(raw)) {
      final fx = _dethaify(raw);
      if (s.boxesRaw.containsKey(fx)) return fx;
      final fl = fx.toLowerCase();
      final f2 = s.boxesRaw.keys.where((k) => k.toLowerCase() == fl);
      if (f2.isNotEmpty) return f2.first;
      return fx;
    }
    return raw;
  }

  // ═══════════════════════ toast ═══════════════════════════════════════════
  void toastMsg(String title, [String sub = '', ResultKind kind = ResultKind.ok]) {
    _toastTimer?.cancel();
    toast = Toast(title, sub, kind);
    notifyListeners();
    _toastTimer = Timer(const Duration(milliseconds: 2600), () {
      toast = null;
      notifyListeners();
    });
  }

  // ═══════════════════════ nav ═════════════════════════════════════════════
  void go(Screen s) {
    touch();
    screen = s;
    notifyListeners();
  }

  /// True once an operator has badged in on a provisioned device.
  bool get hasShift => emp != null && wh.isNotEmpty && gate.isNotEmpty;

  /// Where "back" lands: Home during a session, otherwise the badge screen —
  /// or device setup on a terminal that was never provisioned.
  void backToHome() {
    touch();
    screen = emp != null
        ? Screen.home
        : deviceConfigured
            ? Screen.login
            : Screen.deviceSetup;
    lastResult = null;
    notifyListeners();
  }

  // ═══════════════════════ operator identity ═══════════════════════════════
  /// Everyone on the employee master who is fit to work, with the crew
  /// stationed at this device's warehouse listed first. People assigned
  /// elsewhere are still shown — staff get moved between warehouses for a day
  /// and refusing them would just generate a phone call.
  List<Employee> get employees {
    final raw = S?.employees.values ?? const [];
    final list = raw
        .whereType<Map>()
        .map((m) => Employee.fromJson(Map<String, dynamic>.from(m)))
        .where((e) => e.active && e.name.isNotEmpty)
        .toList();
    list.sort((a, b) {
      final rank = _homeRank(a) - _homeRank(b);
      return rank != 0 ? rank : a.name.compareTo(b.name);
    });
    return list;
  }

  int _homeRank(Employee e) => (e.wh.isEmpty || e.wh == wh) ? 0 : 1;

  /// True when this employee belongs to a different warehouse than the one
  /// this terminal serves — surfaced as a note on screen, never a block.
  bool isVisiting(Employee e) => e.wh.isNotEmpty && wh.isNotEmpty && e.wh != wh;

  /// Starts a session for [e]. Returns an error message to show, or null.
  String? identifyAs(Employee e) {
    if (!e.active) return '${e.name} ไม่อยู่ในสถานะปฏิบัติงาน — ติดต่อหัวหน้างาน';
    emp = e;
    touch();
    screen = Screen.home;
    notifyListeners();
    _connectReader();
    return null;
  }

  /// Resolves a badge value — a QR/barcode from the imager or an EPC from an
  /// RFID card, both arrive here — to an employee. Anything that matches
  /// nobody is ignored rather than explained, so a stray box tag read on the
  /// badge screen is a no-op instead of an error the operator has to dismiss.
  String? identifyByScanCode(String raw) {
    final code = raw.trim();
    if (code.isEmpty) return null;
    final matches = employees.where((e) => e.matchesCode(code)).toList();
    if (matches.isEmpty) return 'ไม่พบบัตรนี้ในระบบ';
    if (matches.length > 1) {
      return 'บัตรนี้ผูกกับพนักงานมากกว่า 1 คน — แตะเลือกชื่อแทน';
    }
    return identifyAs(matches.first);
  }

  /// Badge read from the UI or the reader: identifies, or explains why not.
  void badgeScanned(String code) {
    final err = identifyByScanCode(code);
    if (err != null) toastMsg(err, 'ลองใหม่ หรือแตะชื่อของคุณด้านล่าง', ResultKind.err);
  }

  /// Ends the current operator's session and returns to the badge screen. The
  /// device stays signed in and stationed where it is — this is a handover
  /// between people, not a sign-out of the terminal.
  void lock({bool auto = false}) {
    emp = null;
    queue.clear();
    lastResult = null;
    _clearForms();
    screen = Screen.login;
    if (auto) {
      toastMsg('ล็อกหน้าจออัตโนมัติ', 'ยิงบัตรเพื่อทำงานต่อ', ResultKind.info);
    }
    notifyListeners();
  }

  // ═══════════════════════ idle auto-lock ══════════════════════════════════
  DateTime _lastTouch = DateTime.now();
  Timer? _idleTimer;

  /// Marks the device as in use. Called from every navigation and scan, plus
  /// any pointer event (see RootScreen), so the idle clock tracks real work.
  void touch() => _lastTouch = DateTime.now();

  void _startIdleWatch() {
    _idleTimer?.cancel();
    _idleTimer = Timer.periodic(const Duration(seconds: 30), (_) => checkIdle());
  }

  /// Locks the device if it has sat untouched past the configured limit.
  /// [now] is injectable so the rule can be tested without waiting ten minutes.
  @visibleForTesting
  void checkIdle([DateTime? now]) {
    final limit = prefs.idleLockMinutes;
    if (limit <= 0 || emp == null || busy) return;
    // Never lock with scans pending: those boxes are physically on a truck and
    // dropping them to protect an audit trail would be the worse trade.
    if (queue.isNotEmpty) return;
    if ((now ?? DateTime.now()).difference(_lastTouch).inMinutes >= limit) lock(auto: true);
  }

  // ═══════════════════════ device provisioning ═════════════════════════════
  /// A terminal is provisioned once it has been told which gate it serves.
  bool get deviceConfigured => prefs.deviceGate.isNotEmpty;

  /// Who may re-point the device or edit its connection: a supervisor, or
  /// anyone standing at a locked terminal. The threat this guards against is
  /// an operator changing the gate mid-shift and mis-filing their own scans —
  /// not physical access, which already beats any in-app check, and locking
  /// the badge screen out of Settings would strand a device that can't reach
  /// the server with no way to fix the address.
  bool get canConfigureDevice => emp == null || emp!.isSupervisor;

  /// Viewers can look boxes up but never record a movement.
  bool get canScan => emp?.canScan ?? false;

  void pickWh(String id) {
    wh = id;
    if (S?.gateWh(gate) != id) gate = '';
    // Picking a warehouse with only one gate leaves nothing left to choose.
    final gates = currentGates;
    if (gate.isEmpty && gates.length == 1) gate = '${gates.first}';
    notifyListeners();
  }

  void pickGate(int g) {
    gate = '$g';
    notifyListeners();
  }

  /// Persists this terminal's post. From here on every operator who badges in
  /// works this gate without being asked.
  void saveDevicePost() {
    if (wh.isEmpty || gate.isEmpty) {
      toastMsg('เลือกคลังและประตูก่อน', '', ResultKind.warn);
      return;
    }
    prefs.deviceWh = wh;
    prefs.deviceGate = gate;
    screen = emp != null ? Screen.home : Screen.login;
    notifyListeners();
    toastMsg('ตั้งค่าเครื่องแล้ว', '$selWhName · ประตู $gate', ResultKind.ok);
    _connectReader();
  }

  void setIdleLockMinutes(int m) {
    prefs.idleLockMinutes = m;
    notifyListeners();
  }

  void goDeviceSetup() => go(Screen.deviceSetup);

  // ═══════════════════════ scanning ════════════════════════════════════════
  void setMode(String m) {
    if (!canScan) {
      toastMsg('ไม่มีสิทธิ์บันทึก', 'บัญชีนี้ดูข้อมูลได้อย่างเดียว', ResultKind.warn);
      return;
    }
    touch();
    mode = m;
    screen = Screen.scan;
    queue.clear();
    scanVal = '';
    lastResult = null;
    _clearForms();
    // only one destination customer on file — no real choice to make, so skip the picker
    if (m == 'out' && customerList.length == 1) {
      outCustomer = (customerList.first['id'] ?? '').toString();
    }
    notifyListeners();
    _connectReader();
  }

  void goScanIn() => setMode('in');
  void goScanOut() => setMode('out');

  void goTrack() {
    touch();
    screen = Screen.track;
    trackVal = '';
    trackTag = '';
    trackTried = false;
    notifyListeners();
    _connectReader();
  }

  void onScanChanged(String v) {
    scanVal = v;
    notifyListeners();
  }

  void submitScan() {
    addScan(scanVal);
  }

  void addScan(String raw) {
    raw = raw.trim();
    if (raw.isEmpty) return;
    touch();
    final s = S;
    if (s == null || s.boxesRaw.isEmpty) {
      scanVal = '';
      lastResult = const ScanResult(ResultKind.err, '', 'ยังไม่ได้เชื่อมข้อมูล BoxTrace');
      notifyListeners();
      return;
    }
    final garbled = _looksThaiGarbled(raw);
    final tag = resolveTag(raw);
    final b = s.box(tag);
    if (b == null) {
      scanVal = '';
      lastResult = ScanResult(ResultKind.err, raw,
          'ไม่พบกล่องนี้ในระบบ${garbled ? ' — คีย์บอร์ดอาจอยู่โหมดไทย เปลี่ยนเป็น EN' : ''}');
      notifyListeners();
      return;
    }
    if (mode == 'in') {
      if (b.status == 'warehouse') {
        _reject(tag, ResultKind.warn, 'อยู่ในคลังอยู่แล้ว');
        return;
      }
    } else {
      switch (b.status) {
        case 'out':
          _reject(tag, ResultKind.warn, 'ออกไปแล้ว (ยังไม่คืน)');
          return;
        case 'lost':
          _reject(tag, ResultKind.err, 'ถูกตีเป็นสูญหาย');
          return;
        case 'pending':
          _reject(tag, ResultKind.warn, 'ยังไม่เคยผ่าน Gate เข้าคลัง');
          return;
        case 'hold':
          _reject(tag, ResultKind.warn, 'ถูกพักการใช้งาน (Hold)');
          return;
        case 'damage':
          _reject(tag, ResultKind.err, 'สถานะชำรุด — จ่ายออกไม่ได้');
          return;
        default:
          if (b.status != 'warehouse') {
            _reject(tag, ResultKind.err, 'สถานะไม่พร้อมจ่ายออก');
            return;
          }
      }
    }
    if (queue.contains(tag)) {
      _reject(tag, ResultKind.info, 'อยู่ในคิวแล้ว');
      return;
    }
    final isRet = b.everShipped;
    final msg = mode == 'in'
        ? '${s.typeName(b.type)}${isRet ? ' · รับคืน' : ' · กล่องใหม่'}'
        : s.typeName(b.type);
    queue.add(tag);
    scanVal = '';
    lastResult = ScanResult(ResultKind.ok, tag, msg);
    notifyListeners();
  }

  void _reject(String tag, ResultKind kind, String msg) {
    scanVal = '';
    lastResult = ScanResult(kind, tag, msg);
    notifyListeners();
  }

  void removeFromQueue(String tag) {
    touch();
    queue.remove(tag);
    notifyListeners();
  }

  void clearQueue() {
    touch();
    queue.clear();
    lastResult = null;
    notifyListeners();
  }

  List<Box> _eligible(String m) {
    final s = S;
    if (s == null) return [];
    final want = m == 'in' ? 'out' : 'warehouse';
    return s.boxes.where((b) => b.status == want && !queue.contains(b.tag)).toList();
  }

  /// Dev/testing helpers (kept from the mockup): simulate reads without hardware.
  void simOne() {
    final e = _eligible(mode);
    if (e.isEmpty) {
      toastMsg('ไม่มีกล่องให้จำลอง', mode == 'in' ? 'ไม่มีกล่องที่ออกอยู่' : 'ไม่มีกล่องพร้อมจ่าย', ResultKind.warn);
      return;
    }
    addScan(e[_rnd.nextInt(e.length)].tag);
  }

  void simBurst([int n = 5]) {
    final e = _eligible(mode);
    if (e.isEmpty) {
      toastMsg('ไม่มีกล่องให้จำลอง', '', ResultKind.warn);
      return;
    }
    e.shuffle(_rnd);
    final pick = e.take(min(n, e.length)).toList();
    queue.addAll(pick.map((b) => b.tag));
    lastResult = ScanResult(ResultKind.ok, 'RFID', 'อ่านรวด ${pick.length} ใบ');
    notifyListeners();
  }

  // ═══════════════════════ connectivity / commit ═══════════════════════════
  void toggleOnline() {
    touch();
    online = !online;
    notifyListeners();
    if (online) {
      flushOutbox();
    } else {
      toastMsg('โหมดออฟไลน์', 'การยืนยันจะถูกพักคิวไว้', ResultKind.info);
    }
  }

  void _saveOutbox() => prefs.outbox = outbox.map((e) => e.toJson()).toList();

  Future<void> flushOutbox() async {
    if (outbox.isEmpty) return;
    final pending = List<OutboxTx>.from(outbox);
    busy = true;
    notifyListeners();
    int done = 0;
    final failed = <OutboxTx>[];
    for (final tx in pending) {
      try {
        await _postTx(tx);
        done++;
      } catch (_) {
        failed.add(tx);
      }
    }
    outbox
      ..clear()
      ..addAll(failed);
    _saveOutbox();
    busy = false;
    try {
      await refresh();
    } catch (_) {}
    if (done > 0) {
      toastMsg('ซิงก์สำเร็จ', '$done รายการเข้าสู่ระบบแล้ว', ResultKind.ok);
    }
    if (failed.isNotEmpty) {
      toastMsg('ซิงก์ไม่ครบ', '${failed.length} รายการยังค้าง', ResultKind.warn);
    }
    notifyListeners();
  }

  Future<Map<String, dynamic>> _postTx(OutboxTx tx) {
    if (tx.type == 'in') {
      return api.gateIn(
        tags: tx.tags,
        gate: tx.gate,
        employeeId: tx.employeeId,
        recorder: tx.recorder,
        plate: tx.plate,
        driver: tx.driver,
        vehicleType: tx.vehicleType,
      );
    }
    return api.gateOut(
      tags: tx.tags,
      customer: tx.customer ?? '',
      gate: tx.gate,
      employeeId: tx.employeeId,
      recorder: tx.recorder,
      plate: tx.plate,
      driver: tx.driver,
      vehicleType: tx.vehicleType,
    );
  }

  Future<void> doCommit() async {
    touch();
    if (queue.isEmpty) {
      toastMsg('ยังไม่ได้ยิงกล่อง', '', ResultKind.warn);
      return;
    }
    final s = S;
    final g = int.tryParse(gate) ?? 0;
    final whId = (s?.gateWh(gate).isNotEmpty ?? false) ? s!.gateWh(gate) : wh;
    final recorder = user.isEmpty ? 'PDA' : user;
    final employeeId = emp?.id ?? '';
    final ts = DateTime.now().toUtc().toIso8601String();

    if (mode == 'out' && outCustomer.isEmpty) {
      toastMsg('เลือกลูกค้าปลายทางก่อน', '', ResultKind.warn);
      return;
    }
    final plate = mode == 'in' ? inPlate : outPlate;
    if (plate.trim().isEmpty) {
      toastMsg('กรอกทะเบียนรถก่อน', 'จำเป็นต้องกรอก', ResultKind.warn);
      return;
    }
    final vtypeOther = mode == 'in' ? inVehicleTypeOther : outVehicleTypeOther;
    if ((mode == 'in' ? inVehicleType : outVehicleType) == 'อื่นๆ' && vtypeOther.trim().isEmpty) {
      toastMsg('ระบุประเภทรถ', 'กรอกว่า "อื่นๆ" คือรถประเภทใด', ResultKind.warn);
      return;
    }
    final effInVType = inVehicleType == 'อื่นๆ' && inVehicleTypeOther.trim().isNotEmpty
        ? 'อื่นๆ: ${inVehicleTypeOther.trim()}'
        : inVehicleType;
    final effOutVType = outVehicleType == 'อื่นๆ' && outVehicleTypeOther.trim().isNotEmpty
        ? 'อื่นๆ: ${outVehicleTypeOther.trim()}'
        : outVehicleType;

    final tx = mode == 'in'
        ? OutboxTx(
            type: 'in',
            tags: List.of(queue),
            gate: g,
            wh: whId,
            recorder: recorder,
            employeeId: employeeId,
            ts: ts,
            note: inNote,
            plate: inPlate,
            driver: inDriver,
            vehicleType: effInVType,
          )
        : OutboxTx(
            type: 'out',
            tags: List.of(queue),
            gate: g,
            wh: whId,
            recorder: recorder,
            employeeId: employeeId,
            ts: ts,
            customer: outCustomer,
            plate: outPlate,
            driver: outDriver,
            vehicleType: effOutVType,
          );

    // count new-vs-return locally before we mutate the server (for the toast)
    int nw = 0, rt = 0;
    if (mode == 'in' && s != null) {
      for (final t in queue) {
        final b = s.box(t);
        if (b == null) continue;
        b.everShipped ? rt++ : nw++;
      }
    }

    if (!online) {
      outbox.add(tx);
      _saveOutbox();
      _resetAfterCommit();
      toastMsg('บันทึกออฟไลน์', '${tx.tags.length} ใบ · รอ sync', ResultKind.info);
      return;
    }

    busy = true;
    notifyListeners();
    try {
      if (mode == 'in') {
        await api.gateIn(
          tags: tx.tags,
          gate: g,
          employeeId: employeeId,
          recorder: recorder,
          plate: inPlate,
          driver: inDriver,
          vehicleType: effInVType,
        );
      } else {
        await api.gateOut(
          tags: tx.tags,
          customer: outCustomer,
          gate: g,
          employeeId: employeeId,
          recorder: recorder,
          plate: outPlate,
          driver: outDriver,
          vehicleType: effOutVType,
        );
      }
      final custName = s?.custName(outCustomer) ?? outCustomer;
      final whNm = s?.whName(whId) ?? whId;
      _resetAfterCommit();
      await refresh();
      if (mode == 'in') {
        toastMsg('รับเข้าสำเร็จ', '$nw ใหม่ · $rt คืน → $whNm', ResultKind.ok);
      } else {
        toastMsg('ส่งออกสำเร็จ', '${tx.tags.length} ใบ → $custName', ResultKind.ok);
      }
    } on ApiException catch (e) {
      toastMsg('บันทึกไม่สำเร็จ', e.message, ResultKind.err);
    } catch (e) {
      toastMsg('เชื่อมต่อไม่สำเร็จ', 'บันทึกออฟไลน์ไว้แทน', ResultKind.warn);
      outbox.add(tx);
      _saveOutbox();
      _resetAfterCommit();
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  void _clearForms() {
    outCustomer = '';
    outPlate = '';
    outDriver = '';
    outVehicleType = '';
    outVehicleTypeOther = '';
    inNote = '';
    inPlate = '';
    inDriver = '';
    inVehicleType = '';
    inVehicleTypeOther = '';
  }

  void _resetAfterCommit() {
    queue.clear();
    lastResult = null;
    _clearForms();
    if (mode == 'out' && customerList.length == 1) {
      outCustomer = (customerList.first['id'] ?? '').toString();
    }
    notifyListeners();
  }

  void setOutCustomer(String v) {
    outCustomer = v;
    notifyListeners();
  }

  void setOutPlate(String v) => outPlate = v;
  void setOutDriver(String v) => outDriver = v;
  void setOutVehicleType(String v) {
    outVehicleType = v;
    if (v != 'อื่นๆ') outVehicleTypeOther = '';
    notifyListeners();
  }

  void setOutVehicleTypeOther(String v) => outVehicleTypeOther = v;
  void setInPlate(String v) => inPlate = v;
  void setInDriver(String v) => inDriver = v;
  void setInVehicleType(String v) {
    inVehicleType = v;
    if (v != 'อื่นๆ') inVehicleTypeOther = '';
    notifyListeners();
  }

  void setInVehicleTypeOther(String v) => inVehicleTypeOther = v;

  // ═══════════════════════ track ═══════════════════════════════════════════
  void onTrackChanged(String v) {
    trackVal = v;
  }

  void doTrack() {
    touch();
    final raw = trackVal.trim();
    if (raw.isEmpty) {
      trackTag = '';
      trackTried = false;
      notifyListeners();
      return;
    }
    trackTag = resolveTag(raw);
    trackTried = true;
    notifyListeners();
  }

  Box? get trackBox => (trackTried && S != null) ? S!.box(trackTag) : null;

  // ═══════════════════════ settings ════════════════════════════════════════
  /// Applies the terminal's connection details and re-authenticates. The
  /// service credentials are the device's own — an operator never sees them,
  /// which is the whole point of badging in instead of signing in.
  Future<void> applyConnection({
    required String baseUrl,
    String? username,
    String? password,
  }) async {
    prefs.baseUrl = baseUrl.trim();
    if (username != null && username.trim().isNotEmpty) prefs.username = username.trim();
    if (password != null && password.isNotEmpty) prefs.password = password;
    prefs.token = null;
    api
      ..baseUrl = prefs.baseUrl
      ..token = null;
    busy = true;
    connError = null;
    notifyListeners();
    await _ensureAuthAndState();
    busy = false;
    if (connError == null) {
      toastMsg('เชื่อมต่อสำเร็จ', S == null ? '' : 'พบ ${S!.boxCount} กล่อง', ResultKind.ok);
    } else {
      toastMsg('เชื่อมต่อไม่สำเร็จ', connError!, ResultKind.err);
    }
    notifyListeners();
  }

  // ═══════════════════════ Zebra reader wiring ═════════════════════════════
  bool _readerHooked = false;
  void _connectReader() {
    if (!rfid.supported) return;
    if (_readerHooked && rfid.state == RfidState.connected) return;
    _readerHooked = true;
    rfid.connect();
  }

  void _onReaderTag(String epc) {
    switch (screen) {
      case Screen.scan:
        addScan(epc);
        break;
      case Screen.track:
        trackVal = epc;
        doTrack();
        break;
      case Screen.login:
        // An RFID employee card and a printed badge land in the same place.
        // Box tags swept up along with it match nobody and fall through.
        if (identifyByScanCode(epc) == null) return;
        break;
      default:
        break;
    }
  }

  void _onReaderTrigger(bool pressed) {
    if (screen != Screen.scan && screen != Screen.track && screen != Screen.login) return;
    if (pressed) {
      rfid.startInventory();
    } else {
      rfid.stopInventory();
    }
  }

  // ═══════════════════════ derived getters for the UI ══════════════════════
  bool get connected => S?.connected ?? false;
  int get boxCount => S?.boxCount ?? 0;
  String get selWhName => S?.whName(wh) ?? wh;

  int get warehouseCount => S?.warehouseCount ?? 0;
  int get outCount => S?.outCount ?? 0;

  bool _sameDay(String? ts) {
    if (ts == null) return false;
    final d = DateTime.tryParse(ts)?.toLocal();
    if (d == null) return false;
    final n = DateTime.now();
    return d.year == n.year && d.month == n.month && d.day == n.day;
  }

  int get todayIn => (S?.events ?? [])
      .where((e) => e is Map && (e['dir'] == 'in' || e['dir'] == 'in-new') && _sameDay(e['ts']?.toString()))
      .length;
  int get todayOut => (S?.events ?? [])
      .where((e) => e is Map && e['dir'] == 'out' && _sameDay(e['ts']?.toString()))
      .length;

  List<Map<String, dynamic>> get warehouseList {
    final w = S?.warehouses.values ?? const [];
    return w.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
  }

  List<int> get currentGates => S?.gatesOf(wh) ?? const [];

  /// 'in' | 'out' | 'both' for a gate in the currently selected warehouse —
  /// a gate the warehouse doesn't classify defaults to 'both' here.
  String gateTypeOf(int gate) => S?.gateTypesOf(wh)['$gate'] ?? 'both';

  /// 'in' | 'out' | 'both' for the gate the operator is currently working —
  /// used to hide the Gate In/Out action that doesn't apply to this gate.
  String get currentGateType => gateTypeOf(int.tryParse(gate) ?? 0);

  List<Map<String, dynamic>> get customerList {
    final c = S?.customers.values ?? const [];
    return c.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
  }
}
