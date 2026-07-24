import 'dart:async';
import 'dart:math';
import 'package:flutter/foundation.dart';

import '../models/box.dart';
import '../models/outbox_tx.dart';
import '../models/state_snapshot.dart';
import '../services/api_client.dart';
import '../services/prefs.dart';
import '../services/rfid_service.dart';

enum Screen { boot, login, session, home, scan, track, settings }

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
class AppController extends ChangeNotifier {
  final ApiClient api;
  final Prefs prefs;
  final RfidService rfid;

  AppController({required this.api, required this.prefs, required this.rfid});

  // ── screen + shift ──────────────────────────────────────────────────────
  Screen screen = Screen.boot;
  StateSnapshot? S;

  String user = '';
  String wh = '';
  String gate = '';

  /// Employee/operator accounts (an account IS a login — `users` table).
  /// Fetched with the bootstrap device credentials so the login screen has
  /// real names to show before any operator has authenticated as themselves.
  List<Map<String, dynamic>> users = [];

  // ── scanning ────────────────────────────────────────────────────────────
  String mode = 'in'; // 'in' | 'out'
  final List<String> queue = [];
  String scanVal = '';
  ScanResult? lastResult;

  // out form
  String outCustomer = '';
  String outPlate = '';
  String outDriver = '';
  String inNote = '';

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

    // restore offline queue + shift session
    outbox
      ..clear()
      ..addAll(prefs.outbox.map((e) => OutboxTx.fromJson(Map<String, dynamic>.from(e))));
    final sess = prefs.session;

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

    if (sess != null && sess['user'] != null && sess['wh'] != null && sess['gate'] != null) {
      user = sess['user'].toString();
      wh = sess['wh'].toString();
      gate = sess['gate'].toString();
      screen = Screen.home;
      _connectReader();
    } else {
      screen = Screen.login;
    }
    notifyListeners();

    await loading; // never throws — errors land in connError
    notifyListeners();
  }

  /// Logs in with the device/service credentials from Settings (default
  /// admin/admin123), then loads box state + the employee/user list. This is
  /// the "bootstrap" identity — just enough access to populate the login
  /// screen — separate from an operator's own login (see [loginAsEmployee]),
  /// which replaces the active token once they authenticate as themselves.
  Future<void> _ensureAuthAndState() async {
    try {
      if (api.token == null || api.token!.isEmpty) {
        final r = await api.login(prefs.username, prefs.password);
        prefs.token = r['token'] as String?;
      }
      await refresh();
      await _loadUsers();
      connError = null;
    } on ApiException catch (e) {
      // token may be stale → retry once with a fresh login
      if (e.status == 401) {
        try {
          final r = await api.login(prefs.username, prefs.password);
          prefs.token = r['token'] as String?;
          await refresh();
          await _loadUsers();
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
    notifyListeners();
  }

  Future<void> _loadUsers() async {
    users = await api.listUsers();
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
    screen = s;
    notifyListeners();
  }

  /// True once an operator has picked a warehouse + gate for this shift.
  bool get hasShift => user.isNotEmpty && wh.isNotEmpty && gate.isNotEmpty;

  /// Home is only a valid destination once a shift is running — Settings is
  /// also reachable from the login screen, and backing out of it there must
  /// return to login rather than dropping the operator on an empty Home.
  void backToHome() {
    screen = hasShift ? Screen.home : Screen.login;
    lastResult = null;
    notifyListeners();
  }

  void _saveSession() =>
      prefs.session = {'user': user, 'wh': wh, 'gate': gate};

  /// Authenticates as the tapped employee with their own password via
  /// `POST /api/auth/login`, swapping the active token to theirs on success —
  /// every request after this point (gate in/out, state refresh) acts as
  /// them, not the bootstrap device account. Returns an error message to show
  /// inline in the password prompt, or null on success.
  Future<String?> loginAsEmployee(String username, String password) async {
    busy = true;
    notifyListeners();
    try {
      final r = await api.login(username, password);
      prefs.token = r['token'] as String?;
      final u = Map<String, dynamic>.from(r['user'] as Map);
      user = (u['name'] ?? username).toString();

      _autoSelectSingleOptions();
      if (wh.isNotEmpty && gate.isNotEmpty && warehouseList.length == 1 && currentGates.length == 1) {
        // Only one warehouse and it has only one gate — there is nothing to
        // choose, so skip session setup entirely and start the shift.
        startShift();
      } else {
        screen = Screen.session;
      }
      return null;
    } on ApiException catch (e) {
      return e.message;
    } catch (e) {
      return _msg(e);
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  /// Signs the operator out and re-authenticates as the bootstrap device
  /// account so the login screen's employee list is ready for the next
  /// operator to pick from.
  Future<void> doLogout() async {
    prefs.session = null;
    prefs.token = null;
    api.token = null;
    user = '';
    wh = '';
    gate = '';
    screen = Screen.login;
    notifyListeners();
    await _ensureAuthAndState();
    notifyListeners();
  }

  /// When there's only one warehouse (or the selected warehouse has only one
  /// gate), there's nothing to actually choose — fill it in automatically so
  /// the operator isn't forced to tap a single, obvious option.
  void _autoSelectSingleOptions() {
    final whs = warehouseList;
    if (wh.isEmpty && whs.length == 1) {
      wh = (whs.first['id'] ?? '').toString();
    }
    if (wh.isNotEmpty && gate.isEmpty) {
      final gates = currentGates;
      if (gates.length == 1) gate = '${gates.first}';
    }
  }

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

  void startShift() {
    if (wh.isEmpty || gate.isEmpty) {
      toastMsg('เลือกคลังและประตูก่อน', '', ResultKind.warn);
      return;
    }
    _saveSession();
    screen = Screen.home;
    notifyListeners();
    _connectReader();
  }

  void goSessionEdit() => go(Screen.session);

  void setMode(String m) {
    mode = m;
    screen = Screen.scan;
    queue.clear();
    scanVal = '';
    lastResult = null;
    outCustomer = '';
    outPlate = '';
    outDriver = '';
    inNote = '';
    notifyListeners();
    _connectReader();
  }

  void goScanIn() => setMode('in');
  void goScanOut() => setMode('out');

  void goTrack() {
    screen = Screen.track;
    trackVal = '';
    trackTag = '';
    trackTried = false;
    notifyListeners();
    _connectReader();
  }

  // ═══════════════════════ scanning ════════════════════════════════════════
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
    queue.remove(tag);
    notifyListeners();
  }

  void clearQueue() {
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
      return api.gateIn(tags: tx.tags, gate: tx.gate, recorder: tx.recorder);
    }
    return api.gateOut(
      tags: tx.tags,
      customer: tx.customer ?? '',
      gate: tx.gate,
      recorder: tx.recorder,
    );
  }

  Future<void> doCommit() async {
    if (queue.isEmpty) {
      toastMsg('ยังไม่ได้ยิงกล่อง', '', ResultKind.warn);
      return;
    }
    final s = S;
    final g = int.tryParse(gate) ?? 0;
    final whId = (s?.gateWh(gate).isNotEmpty ?? false) ? s!.gateWh(gate) : wh;
    final recorder = user.isEmpty ? 'PDA' : user;
    final ts = DateTime.now().toUtc().toIso8601String();

    if (mode == 'out' && outCustomer.isEmpty) {
      toastMsg('เลือกลูกค้าปลายทางก่อน', '', ResultKind.warn);
      return;
    }

    final tx = mode == 'in'
        ? OutboxTx(type: 'in', tags: List.of(queue), gate: g, wh: whId, recorder: recorder, ts: ts, note: inNote)
        : OutboxTx(
            type: 'out',
            tags: List.of(queue),
            gate: g,
            wh: whId,
            recorder: recorder,
            ts: ts,
            customer: outCustomer,
            plate: outPlate,
            driver: outDriver,
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
        await api.gateIn(tags: tx.tags, gate: g, recorder: recorder);
      } else {
        await api.gateOut(tags: tx.tags, customer: outCustomer, gate: g, recorder: recorder);
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

  void _resetAfterCommit() {
    queue.clear();
    lastResult = null;
    outCustomer = '';
    outPlate = '';
    outDriver = '';
    inNote = '';
    notifyListeners();
  }

  void setOutCustomer(String v) {
    outCustomer = v;
    notifyListeners();
  }

  void setOutPlate(String v) => outPlate = v;
  void setOutDriver(String v) => outDriver = v;

  // ═══════════════════════ track ═══════════════════════════════════════════
  void onTrackChanged(String v) {
    trackVal = v;
  }

  void doTrack() {
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
  /// The device/service credentials (Prefs.username/password) stay fixed —
  /// they're an internal bootstrap detail for listing employees before anyone
  /// has authenticated as themselves, not something an operator should need
  /// to see or edit. Only the API's location is configurable here.
  Future<void> applyConnection({required String baseUrl}) async {
    prefs.baseUrl = baseUrl.trim();
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
    if (screen == Screen.scan) {
      addScan(epc);
    } else if (screen == Screen.track) {
      trackVal = epc;
      doTrack();
    }
  }

  void _onReaderTrigger(bool pressed) {
    if (screen != Screen.scan && screen != Screen.track) return;
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

  List<Map<String, dynamic>> get customerList {
    final c = S?.customers.values ?? const [];
    return c.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
  }
}
