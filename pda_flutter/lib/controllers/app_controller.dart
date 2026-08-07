import 'dart:async';
import 'dart:io' show SocketException;
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show HapticFeedback;

import '../models/box.dart';
import '../models/damaged_flag.dart';
import '../models/employee.dart';
import '../models/outbox_tx.dart';
import '../models/state_snapshot.dart';
import '../services/api_client.dart';
import '../services/prefs.dart';
import '../services/realtime_service.dart';
import '../services/rfid_service.dart';

enum Screen {
  boot,
  deviceSetup,
  login,
  home,
  scan,
  track,
  settings,
  rfidInput,
  rfidRegister,
  rfidLocate,
  boxRegister,
  damagedBox,
}

/// Which physical input a trigger pull means right now, on any screen that
/// offers both — Gate scanning, Track, and RfidLocateScreen's own box-pick
/// step. Centralized (not per-screen local state) because the trigger
/// itself is wired centrally too (AppController._onReaderTrigger is the
/// only place a hardware trigger event turns into rfid.startInventory()) —
/// a screen-local toggle that this dispatcher never saw was exactly how a
/// "barcode mode" selection still silently started RFID reads and beeped.
enum ScanInputMode { barcode, rfid }

/// Human-readable message for an arbitrary error, in Thai where the shape
/// of the failure is common enough to name — a raw TimeoutException prints
/// as "TimeoutException after 0:00:20.000000: Future not completed", which
/// is what every toast/banner used to show verbatim on a dead connection.
/// [ApiException]'s own `.message` is already meant for operators, so that
/// passes straight through; everything else gets Dart's leading
/// `SomethingException: ` stripped (matched only at the start, so
/// `ClientException: Failed to fetch` doesn't get mangled into
/// `ClientFailed`) as the last-resort fallback.
String friendlyError(Object e) {
  if (e is ApiException) return e.message;
  if (e is TimeoutException) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ — หมดเวลารอ ตรวจสอบที่อยู่เซิร์ฟเวอร์และเครือข่าย';
  if (e is SocketException) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบที่อยู่เซิร์ฟเวอร์และเครือข่าย';
  final s = e.toString();
  final m = RegExp(r'^[A-Za-z_]*(Exception|Error): ').firstMatch(s);
  return m == null ? s : s.substring(m.end);
}

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
///    [Prefs] and stays signed in for good. Its provisioned warehouse/gate
///    ([Prefs.deviceWh]/[Prefs.deviceGate]) is only ever a starting suggestion
///    for the report screen's picker below — the same handheld may work
///    different gates across a shift.
///  * The **operator** is a row of the WMS employee master ([Employee]) chosen
///    by scanning their badge. There is no account and no password behind it,
///    so people are managed entirely from the web app's "พนักงาน" page.
///
/// Every badge-in lands on the report screen, which asks the operator to
/// confirm a warehouse then a gate. If there is only one warehouse, the
/// picker jumps straight to that warehouse's gate list; if there is only one
/// gate, it confirms the post outright. See [postConfirmed],
/// [selectPendingWh], [confirmPost].
class AppController extends ChangeNotifier {
  final ApiClient api;
  final Prefs prefs;
  final RfidService rfid;

  AppController({required this.api, required this.prefs, required this.rfid});

  // ── screen + shift ──────────────────────────────────────────────────────
  Screen screen = Screen.boot;
  StateSnapshot? S;

  /// True only once a live `GET /api/state` has actually succeeded this
  /// session — set in [refresh]. `S` alone can't answer this: it's also
  /// populated eagerly at boot from [Prefs.stateCache] so a terminal with no
  /// network yet still has employee/box data to show, and a fresh warehouse
  /// with zero boxes registered is a perfectly valid live connection too, so
  /// nothing about the snapshot's *contents* can stand in for this.
  bool _liveConnected = false;

  /// The operator currently holding the device — null whenever it is locked.
  Employee? emp;

  /// Display name of [emp]; kept as a plain string because it is what gets
  /// written to `recorder` and shown in every header.
  String get user => emp?.name ?? '';

  String wh = '';
  String gate = '';

  /// Badged in but hasn't picked a warehouse/gate for this visit to the
  /// report screen yet — the "งานหลัก" action buttons stay hidden behind a
  /// เลือกคลัง/เลือกประตู list until this flips true. Reset on every fresh
  /// badge-in by [_resetPost]; auto-true when there is truly nothing to pick
  /// (a single warehouse with a single gate) or the operator is a viewer who
  /// only searches and never needs a post at all.
  bool postConfirmed = false;

  /// The warehouse picked mid-flow, before a gate has been chosen for it —
  /// separate from [wh] (the *confirmed* post) so the report screen's list
  /// doesn't clobber [isVisiting]/employee ranking while a pick is still in
  /// progress.
  String? pendingWh;

  // ── scanning ────────────────────────────────────────────────────────────
  String mode = 'in'; // 'in' | 'out'
  final List<String> queue = [];

  /// Per-tag condition flagged on the Gate In queue — 'hold' or 'damage'
  /// instead of the default 'warehouse' landing spot. Gate Out never reads
  /// this (a damaged box can't ship — the server already refuses that), it
  /// only ever applies to [doCommit]'s 'in' branch.
  final Map<String, String> queueConditions = {};

  void setQueueCondition(String tag, String? condition) {
    if (condition == null) {
      queueConditions.remove(tag);
    } else {
      queueConditions[tag] = condition;
    }
    notifyListeners();
  }
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
  final List<OutboxTx> outbox = [];
  final List<DamagedFlag> damagedFlags = [];

  // ── track ───────────────────────────────────────────────────────────────
  String trackVal = '';
  String trackTag = '';
  bool trackTried = false;
  bool trackSearching = false;
  String? trackError;

  // ── settings ────────────────────────────────────────────────────────────
  RfidStatus rfidStatus = const RfidStatus(RfidState.idle, '');
  String? connError;
  bool busy = false;

  Toast? toast;
  Timer? _toastTimer;
  final _rnd = Random();
  StreamSubscription? _tagSub, _trigSub, _statusSub;
  final _realtime = RealtimeService();
  Timer? _realtimeDebounce;

  // ═══════════════════════ lifecycle ═══════════════════════════════════════
  Future<void> init() async {
    api.baseUrl = prefs.baseUrl;
    api.token = prefs.token;
    api.apiKey = prefs.apiKey;
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

    damagedFlags
      ..clear()
      ..addAll(prefs.damagedFlags.map((e) => DamagedFlag.fromJson(Map<String, dynamic>.from(e))));

    wh = prefs.deviceWh;
    gate = prefs.deviceGate;

    // wire the Zebra reader — tagBatches (not the plain-epc tags stream)
    // because the stray-read RSSI filter (see _onReaderBatch) needs each
    // read's signal strength, which only the raw stream carries.
    _tagSub = rfid.tagBatches.listen(_onReaderBatch);
    _trigSub = rfid.triggers.listen(_onReaderTrigger);
    _statusSub = rfid.status.listen((s) {
      rfidStatus = s;
      // Reader firmware resets to full power on every connect, so the
      // saved ใกล้/ปานกลาง/ไกล pick has to be re-applied each time — not
      // just when the operator changes it in settings.
      if (s.state == RfidState.connected) {
        rfid.setPowerPercent(prefs.rfidPowerPercent);
        // Same reasoning: the native read-callback tick has no way to ask
        // Dart which tone/volume to play per read, so it has to be told once
        // here (and again on every change — see Settings' tone picker).
        rfid.setBeepStyle(toneId: prefs.rfidToneId, volumePercent: prefs.rfidVolumePercent);
      }
      notifyListeners();
    });

    // Auth + state load runs alongside the splash so a slow or unreachable
    // backend never holds the UI hostage — screens render, then fill in.
    final loading = _ensureAuthAndState();
    // Live push (see RealtimeService) so a change made anywhere else — the
    // web app, another PDA, a direct API call — shows up here without the
    // operator needing to leave the screen and back to force a refetch, same
    // as the web app already does over the same /api/stream channel. Its own
    // retry loop handles "no token yet" / "backend unreachable at boot" —
    // safe to call before [loading] settles.
    _realtime.connect(
      baseUrl: () => api.baseUrl,
      token: () => api.token,
      onStateChanged: _onRealtimeStateChanged,
      onConnectivity: _onRealtimeConnectivity,
    );
    await Future.delayed(const Duration(milliseconds: 420));

    // No operator is ever restored: a shift always starts with a badge scan,
    // which takes a second and can't mis-attribute the next person's work.
    screen = deviceConfigured ? Screen.login : Screen.deviceSetup;
    if (deviceConfigured) {
      _connectReader();
    } else {
      _autoSelectSinglePost();
    }
    notifyListeners();

    await loading; // never throws — errors land in connError
    // Only now, on a device with no cached snapshot, is the warehouse list
    // known — so a fresh terminal gets its single option filled in too.
    if (screen == Screen.deviceSetup) _autoSelectSinglePost();
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
  ///
  /// Every failure branch here used to leave [_liveConnected] (what actually
  /// drives the header's online/offline icon) untouched — it only ever went
  /// true, in [refresh]. That left a real, just-failed connection attempt
  /// (a login or state fetch that timed out) showing a stale "online" icon
  /// until the SSE stream's own, slower reconnect loop eventually noticed —
  /// seconds behind what a REST call right here already knows for certain.
  /// Now every path out of this method reconciles [_liveConnected] with
  /// whether [connError] ended up set, the same instant it's known.
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
          _syncLiveConnected();
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
    _syncLiveConnected();
  }

  /// Reconciles [_liveConnected] with the [connError] that whatever just
  /// called [_ensureAuthAndState] left behind — offline the moment a
  /// connectivity failure is known, same [offlineEventId]/notify semantics
  /// as [_onRealtimeConnectivity] going down, so the one-shot offline alert
  /// still fires exactly once per real drop rather than being silent here
  /// and only caught later by the SSE stream's own, slower detection.
  void _syncLiveConnected() {
    if (connError == null) return;
    final wasConnected = _liveConnected;
    _liveConnected = false;
    if (wasConnected) offlineEventId++;
  }

  /// Explicit reconnect for the badge screen's small online/offline
  /// indicator — tap it and it actually tries, instead of only ever
  /// discovering connectivity changed on the next unrelated network call.
  /// [_liveConnected] otherwise only ever goes true (see [refresh]); this is
  /// the one place it's allowed back to false, so the indicator doesn't keep
  /// showing "online" from an earlier session after a live probe just
  /// failed. Returns the resulting [connected] state so the caller can
  /// decide whether to say anything more (see login_screen's connectivity
  /// icon, which surfaces a "ตั้งค่าระบบ" prompt only when this is false).
  Future<bool> retryConnection() async {
    await _ensureAuthAndState(); // reconciles _liveConnected itself now
    notifyListeners();
    return connected;
  }

  Future<void> refresh() async {
    final json = await api.getState();
    S = StateSnapshot.fromJson(json);
    prefs.stateCache = json;
    _liveConnected = true;
    notifyListeners();
  }

  /// Debounced so a burst of several 'state' pings close together (e.g. a
  /// bulk edit on the web app) triggers one refetch, not one per ping.
  void _onRealtimeStateChanged() {
    _realtimeDebounce?.cancel();
    _realtimeDebounce = Timer(const Duration(milliseconds: 300), () {
      // A dropped refresh here just waits for the next ping (or the next
      // local action's own refresh()) — nothing else depends on it landing.
      refresh().catchError((_) {});
    });
  }

  /// Bumped exactly when live connectivity transitions from up to down —
  /// never on a routine retry attempt, never on any other notifyListeners()
  /// call. root_screen.dart's _OfflineAlertListener watches this via
  /// context.select to show a one-shot offline AlertDialog regardless of
  /// which screen is on top, so a Wi-Fi blip surfaces once, not on every
  /// heartbeat the SSE stream misses while it reconnects.
  int offlineEventId = 0;

  /// Realtime up/down signal from the SSE stream (see RealtimeService) —
  /// the connection to the backend dying is usually known within moments,
  /// not only whenever the next unrelated REST call happens to fail. This is
  /// the one place [_liveConnected] is allowed back to false; [refresh]
  /// itself only ever sets it true.
  void _onRealtimeConnectivity(bool up) {
    final wasConnected = _liveConnected;
    _liveConnected = up;
    if (up) {
      connError = null;
      // Walked back into signal after queuing scans in a dead zone: sync
      // straight to the server in the background, no operator action
      // needed. Only worth trying if there's actually something queued and
      // this isn't the very first connect of the session (nothing to flush
      // yet either way, and it would race the boot-time refresh()).
      if (!wasConnected && outbox.isNotEmpty) flushOutbox();
      if (!wasConnected && damagedFlags.any((f) => !f.synced)) flushDamagedFlags();
    } else {
      // Deliberately left null when nothing more specific is known — the
      // dialog and the reconnect sheet both have their own wording for
      // "just offline", and echoing a generic string here only made the
      // alert repeat its own title back as the body.
      if (wasConnected) offlineEventId++;
    }
    notifyListeners();
  }

  String _msg(Object e) => friendlyError(e);

  @override
  void dispose() {
    _toastTimer?.cancel();
    _tagSub?.cancel();
    _trigSub?.cancel();
    _statusSub?.cancel();
    _realtimeDebounce?.cancel();
    _realtime.dispose();
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
    // RFID EPC/TID reads never match a tag key directly — look them up by
    // value (case-insensitive, since readers vary on hex casing).
    final byRfid = s.tagForCode(raw);
    if (byRfid != null) return byRfid;
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

  /// True once an operator has badged in on a provisioned device.
  bool get hasShift => emp != null && wh.isNotEmpty && gate.isNotEmpty;

  /// Where "back" lands: Home during a session, otherwise the badge screen —
  /// or device setup on a terminal that was never provisioned.
  void backToHome() {
    screen = emp != null
        ? Screen.home
        : deviceConfigured
            ? Screen.login
            : Screen.deviceSetup;
    lastResult = null;
    notifyListeners();
  }

  /// Non-default "what does the system back control do right now" override.
  /// Every screen's back is exactly backToHome() — what handleSystemBack()
  /// falls through to below when this is null — except
  /// RfidLocateScreen's .locate step, whose back has to return to .pick,
  /// not exit to Home; that's local widget state AppController otherwise
  /// has no way to see. Set fresh every build by whichever screen needs it
  /// (see RfidLocateScreen.build), so it's never stale after a navigation.
  VoidCallback? systemBackOverride;

  /// What the Android system back control (3-button nav / edge-swipe gesture)
  /// does — always in-app navigation, never "exit the app". root_screen.dart
  /// blocks the framework's own pop entirely (PopScope(canPop: false)) and
  /// routes here instead, the same as every screen's own StickyHeader back
  /// arrow already does, so a hardware press and an on-screen tap behave
  /// identically. A no-op on deviceSetup with nothing configured yet (same
  /// as that screen's StickyHeader passing onBack: null) and on the
  /// screens that are themselves the top of the stack — there's nowhere
  /// further back to go without exiting, which this must never do.
  void handleSystemBack() {
    if (systemBackOverride != null) {
      systemBackOverride!();
      return;
    }
    if (screen == Screen.deviceSetup && !deviceConfigured) return;
    if (screen == Screen.home || screen == Screen.login || screen == Screen.boot) return;
    backToHome();
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
    final last = prefs.lastEmpId;
    list.sort((a, b) {
      // Whoever used this terminal last goes first — on a device worked by
      // the same one or two people all week, that's almost always the person
      // holding it now, and it saves them scrolling for their own name.
      if (last.isNotEmpty) {
        final lastRank = (a.id == last ? 0 : 1) - (b.id == last ? 0 : 1);
        if (lastRank != 0) return lastRank;
      }
      final rank = _homeRank(a) - _homeRank(b);
      return rank != 0 ? rank : a.name.compareTo(b.name);
    });
    return list;
  }

  /// Employee id of the last person to start a shift on this device, or ''.
  /// The badge screen tags this row "ล่าสุด"; it changes ordering and nothing
  /// else — the PIN gate is identical either way.
  String get lastEmpId => prefs.lastEmpId;

  int _homeRank(Employee e) => (e.wh.isEmpty || e.wh == wh) ? 0 : 1;

  /// True when this employee belongs to a different warehouse than the one
  /// this terminal serves — surfaced as a note on screen, never a block.
  bool isVisiting(Employee e) => e.wh.isNotEmpty && wh.isNotEmpty && e.wh != wh;

  /// Patches the cached snapshot's `hasPin` flag for [employeeId] right after
  /// a successful `setEmployeePin` call. Without this, `S` (built from the
  /// last `/api/state` fetch, which can be minutes old) still says
  /// `hasPin: false` for the rest of this session — so a lock/re-badge before
  /// the next fetch would ask the operator to set a PIN they just set.
  void markPinSet(String employeeId) {
    final raw = S?.employees[employeeId];
    if (raw is! Map) return;
    S!.employees[employeeId] = {...raw, 'hasPin': true};
    notifyListeners();
  }

  /// Starts a session for [e]. Returns an error message to show, or null.
  String? identifyAs(Employee e) {
    if (!e.active) return '${e.name} ไม่อยู่ในสถานะปฏิบัติงาน — ติดต่อหัวหน้างาน';
    emp = e;
    prefs.lastEmpId = e.id;
    _resetPost();
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
  void lock() {
    emp = null;
    queue.clear();
    queueConditions.clear();
    lastResult = null;
    _clearForms();
    screen = Screen.login;
    notifyListeners();
  }

  // ═══════════════════════ device provisioning ═════════════════════════════
  /// A terminal is provisioned once someone has completed device_setup_screen
  /// at least once (see finishDeviceSetup) — not tied to a fixed gate, since
  /// warehouse/gate are picked per-visit instead.
  bool get deviceConfigured => prefs.deviceConfigured;

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

  // ═══════════════════════ report-screen post picker ════════════════════════
  /// Called on every fresh badge-in. Clears any pick left over from a
  /// previous operator and decides whether there's really a choice to make.
  void _resetPost() {
    pendingWh = null;
    if (!canScan) {
      // A viewer only ever searches — that's warehouse-agnostic, so don't
      // make them pick a post before they're allowed to do anything at all.
      postConfirmed = true;
      return;
    }
    final whs = warehouseList;
    if (whs.length == 1) {
      final id = (whs.first['id'] ?? '').toString();
      final gates = S?.gatesOf(id) ?? const [];
      pendingWh = id;
      if (gates.length == 1) {
        confirmPost(id, gates.first);
        return;
      }
      postConfirmed = false;
      return;
    }
    postConfirmed = false;
  }

  /// Step 1 of the report-screen picker — choose a warehouse. Skips straight
  /// to confirming when that warehouse has only one gate.
  void selectPendingWh(String id) {
    pendingWh = id;
    final gates = S?.gatesOf(id) ?? const [];
    if (gates.length == 1) {
      confirmPost(id, gates.first);
    } else {
      notifyListeners();
    }
  }

  /// Step 2 — choose the gate within [pendingWh], locking in this visit's
  /// post and revealing the action buttons.
  void confirmPost(String whId, int g) {
    wh = whId;
    gate = '$g';
    pendingWh = null;
    postConfirmed = true;
    _rememberLastPost();
    notifyListeners();
  }

  /// Back out of the gate list to pick a different warehouse.
  void clearPendingWh() {
    pendingWh = null;
    notifyListeners();
  }

  /// Lets the operator pick a different warehouse/gate mid-shift without a
  /// full handover — e.g. moving from one gate to another. Re-runs the same
  /// logic a fresh badge-in gets.
  void reselectPost() {
    _resetPost();
    notifyListeners();
  }

  /// The last step of device_setup_screen.dart's bottom button, enabled once
  /// [connected] is true. Warehouse/gate are no longer fixed at setup time —
  /// they're picked per-visit instead (see pickWh/pickGate/confirmPost) — so
  /// "configured" now just means this terminal has a working connection and
  /// has been through setup once.
  void finishDeviceSetup() {
    prefs.deviceConfigured = true;
    screen = emp != null ? Screen.home : Screen.login;
    notifyListeners();
    toastMsg('ตั้งค่าเครื่องแล้ว', '', ResultKind.ok);
    _connectReader();
  }

  void setDeviceModel(String id) {
    prefs.deviceModel = id;
    notifyListeners();
  }

  void goDeviceSetup() {
    _autoSelectSinglePost();
    go(Screen.deviceSetup);
  }

  /// A site with one warehouse — or a warehouse with one gate — offers no real
  /// choice, so fill it in rather than making whoever provisions the device tap
  /// the only option there is. [pickWh] handles the single-gate half.
  void _autoSelectSinglePost() {
    if (wh.isNotEmpty) return;
    final whs = warehouseList;
    if (whs.length == 1) pickWh((whs.first['id'] ?? '').toString());
  }

  // ═══════════════════════ scanning ════════════════════════════════════════
  void setMode(String m) {
    if (!canScan) {
      toastMsg('ไม่มีสิทธิ์บันทึก', 'บัญชีนี้ดูข้อมูลได้อย่างเดียว', ResultKind.warn);
      return;
    }
    mode = m;
    screen = Screen.scan;
    queue.clear();
    queueConditions.clear();
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

  // ═══════════════════════ "ล่าสุด" shortcut ═══════════════════════════════
  /// คนละแนวคิดกับ deviceWh/deviceGate (ค่าประจำเครื่อง ตั้งครั้งเดียวตอน
  /// provisioning) — นี่คือคลัง/ประตูที่ *คนที่กำลังใช้เครื่องอยู่ตอนนี้* เพิ่งยืนยันจาก
  /// หน้ารายงานจริงๆ ไม่ว่าจะผ่านการเลือกเองหรือข้ามมาเพราะมีตัวเลือกเดียว จึงบันทึก
  /// จากจุดเดียวใน [confirmPost] ให้ครอบคลุมทุกเส้นทาง
  void _rememberLastPost() {
    prefs.lastWh = wh;
    prefs.lastGate = gate;
    // Best-effort — the device-local prefs above are already the fallback
    // if this never lands (offline, server hiccup), and a shift is already
    // underway by the time this fires, so nothing here should block or
    // retry; the next confirmPost() on any terminal tries again anyway.
    final e = emp;
    if (e != null) {
      api.setEmployeeLastPost(e.id, wh: wh, gate: gate).catchError((_) {});
    }
  }

  /// The server-side value (this employee's last post on *any* terminal)
  /// wins when it's known; device-local prefs are the fallback for a badge
  /// screen that hasn't fetched fresh employee data yet, or an employee who
  /// has only ever worked this one PDA.
  bool get hasLastSelection => lastWh.isNotEmpty && lastGate.isNotEmpty;
  String get lastWh => emp?.lastWh.isNotEmpty == true ? emp!.lastWh : prefs.lastWh;
  String get lastWhName => S?.whName(lastWh) ?? lastWh;
  String get lastGate => emp?.lastGate.isNotEmpty == true ? emp!.lastGate : prefs.lastGate;

  /// ยืนยันคลัง/ประตูล่าสุดในคลิกเดียว ข้ามหน้าเลือกคลัง/ประตูทั้งหมด — ใช้ได้ก็ต่อเมื่อ
  /// คลังและประตูนั้นยังมีอยู่จริงตอนนี้ (กันกรณีถูกลบ/ย้ายไปหลังจากบันทึกไว้)
  void useLastPost() {
    final w = lastWh, g = lastGate;
    if (w.isEmpty || g.isEmpty) return;
    if (!warehouseList.any((x) => (x['id'] ?? '').toString() == w)) {
      toastMsg('ไม่พบคลังเดิม', 'คลังนี้อาจถูกลบหรือย้ายไปแล้ว', ResultKind.warn);
      return;
    }
    final gi = int.tryParse(g);
    if (gi == null || !(S?.gatesOf(w) ?? const []).contains(gi)) {
      toastMsg('ไม่พบประตูเดิม', 'ประตูนี้อาจถูกลบหรือย้ายไปแล้ว', ResultKind.warn);
      return;
    }
    confirmPost(w, gi);
  }

  void goTrack() {
    screen = Screen.track;
    _trackSeq++;
    trackVal = '';
    trackTag = '';
    trackTried = false;
    trackSearching = false;
    trackError = null;
    notifyListeners();
    _connectReader();
  }

  /// "Find this box" — Geiger-style RFID search (see RfidLocateScreen). Its
  /// own screen state (which box, current RSSI) lives on the widget, not
  /// here — this just gets the reader connected and the trigger unlocked for
  /// it, same as every other RFID-reading screen.
  void goLocate() {
    screen = Screen.rfidLocate;
    notifyListeners();
    _connectReader();
  }

  /// Fast-path box commissioning (see RfidRegisterScreen). Lived under
  /// Settings before — moved next to the Gate In/Out cards on Home since
  /// it's a routine warehouse-floor action, not device configuration.
  void goRfidRegister() {
    screen = Screen.rfidRegister;
    notifyListeners();
    _connectReader();
  }

  /// Receiving flow: create -> label -> tag -> putaway (see
  /// BoxRegisterScreen), copied from legacy.html's own box-registration +
  /// putaway handlers.
  void goBoxRegister() {
    screen = Screen.boxRegister;
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

  /// [viaRfid] says which of the two "a box landed" sounds to play — true
  /// when this call came from a trigger-pulled RFID read (AppController's
  /// own _onReaderBatch/_onReaderTag), false for a typed/scanned barcode
  /// (ScanScreen's own _submit). It changes nothing else about how the scan
  /// is processed.
  void addScan(String raw, {bool viaRfid = false}) {
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
    // The one sound a Gate scan makes per box: a tag read for the first
    // time this session. A held trigger can re-read the same tag dozens of
    // times a second — those land in _reject's ResultKind.info branch
    // below, silently, which is what keeps a 5-tag pallet at exactly 5
    // ticks instead of however many times the reader happened to see it.
    //
    // Barcode detections always get the same fixed tone — only the RFID
    // channel is user-configurable (see prefs.rfidToneId/rfidVolumePercent).
    // A trigger-pulled RFID read landing here still gets the operator's
    // chosen RFID sound rather than this fixed one, so an RFID detection
    // sounds the same everywhere it happens.
    if (viaRfid) {
      rfid.playSound(prefs.rfidToneId, volumePercent: prefs.rfidVolumePercent);
    } else {
      rfid.playTone('ok');
    }
    notifyListeners();
  }

  void _reject(String tag, ResultKind kind, String msg) {
    scanVal = '';
    lastResult = ScanResult(kind, tag, msg);
    // A duplicate read of a tag already in the queue (ResultKind.info) is
    // silent by design — a held trigger re-reads the same box constantly,
    // and a beep for every one of those is exactly the noise this was
    // asked to stop making. A genuine rejection (wrong status, unknown
    // tag) is the "this isn't right" case: an error tone plus a vibration,
    // so it's felt as well as heard on a warehouse floor.
    if (kind != ResultKind.info) {
      rfid.playTone('error');
      HapticFeedback.vibrate();
    }
    notifyListeners();
  }

  void removeFromQueue(String tag) {
    queue.remove(tag);
    queueConditions.remove(tag);
    notifyListeners();
  }

  void clearQueue() {
    queue.clear();
    queueConditions.clear();
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

  /// Always on — the leaner animation/refresh behaviour every screen already
  /// branches on by this flag (zero-duration transitions, longer background
  /// polling, …) reads as smoother and less janky, not as a compromise, so
  /// there is no reason it should ever have been optional. Kept as a getter
  /// (rather than inlining `true` at every call site) purely so those call
  /// sites don't have to change if a real per-device toggle is ever needed
  /// again.
  bool get lowPowerMode => true;

  /// Session-only (not persisted) — starts each fresh entry into a
  /// scan/track/locate screen on บาร์โค้ด, same as before this existed.
  ScanInputMode scanInputMode = ScanInputMode.barcode;
  void setScanInputMode(ScanInputMode m) {
    if (scanInputMode == m) return;
    scanInputMode = m;
    // Switching to barcode while the trigger is still physically held (or
    // an inventory is running from before the switch) must not leave the
    // reader sweeping in the background on a mode that just said "don't".
    if (m == ScanInputMode.barcode) rfid.stopInventory();
    notifyListeners();
  }

  // ═══════════════════════ connectivity / commit ═══════════════════════════
  /// Tap-to-retry for the online/offline chip, wherever it appears (badge
  /// screen, Home, Gate) — one real attempt against the backend right now;
  /// if that still fails, hands off to the same server-address screen
  /// device setup uses instead of a second "edit connection" surface.
  /// There is deliberately no way to force [connected] to either value from
  /// here or anywhere else in the UI — it used to be a separate manual
  /// toggle, which is exactly what let the chip disagree with whether the
  /// terminal could actually reach the server.
  Future<void> retryOrConfigure() async {
    if (connected) return;
    final ok = await retryConnection();
    if (ok) return;
    toastMsg('ยังเชื่อมต่อไม่ได้', 'เปิดหน้าตั้งค่าเซิร์ฟเวอร์ให้แล้ว', ResultKind.warn);
    goDeviceSetup();
  }

  /// The outbox banner's own "ซิงก์เลย" button — an explicit nudge for an
  /// operator who knows signal just came back and doesn't want to wait for
  /// the SSE stream's own backoff to notice. Reconnecting alone doesn't
  /// flush ([_onRealtimeConnectivity]'s up-edge is the only place that does
  /// today), so this does both: retry, then flush whatever's queued if that
  /// retry actually landed.
  Future<void> syncNow() async {
    final ok = await retryConnection();
    if (!ok) {
      toastMsg('ยังออฟไลน์อยู่', connError ?? '', ResultKind.warn);
      return;
    }
    if (outbox.isNotEmpty) await flushOutbox();
    if (damagedFlags.any((f) => !f.synced)) await flushDamagedFlags();
  }

  void _saveOutbox() => prefs.outbox = outbox.map((e) => e.toJson()).toList();

  Future<void> flushOutbox() async {
    if (outbox.isEmpty) return;
    final pending = List<OutboxTx>.from(outbox);
    busy = true;
    notifyListeners();
    int done = 0;
    final failed = <OutboxTx>[];
    // A rejection the server actually processed and refused (ApiException —
    // e.g. the box was put on Hold, marked Damaged/Lost, or already shipped
    // by someone else since this scan was queued) will refuse the exact same
    // way every time. Retrying it forever just re-fails silently on every
    // sync and leaves the operator staring at a "ค้าง" count with no way to
    // clear it short of wiping the outbox — so it's dropped here instead,
    // same as the live (non-outbox) path in doCommit() already does. Anything
    // else (timeout, no connection) genuinely might succeed next time, so
    // that one still goes back in the queue.
    String? rejectedReason;
    int rejectedCount = 0;
    for (final tx in pending) {
      try {
        await _postTx(tx);
        done++;
      } on ApiException catch (e) {
        rejectedCount++;
        rejectedReason ??= e.message;
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
    if (rejectedCount > 0) {
      toastMsg('ตัดรายการที่ระบบปฏิเสธ', '$rejectedCount รายการ · ${rejectedReason ?? ''}', ResultKind.err);
    }
    if (failed.isNotEmpty) {
      toastMsg('ซิงก์ไม่ครบ', '${failed.length} รายการยังค้าง', ResultKind.warn);
    }
    notifyListeners();
  }

  void _saveDamagedFlags() => prefs.damagedFlags = damagedFlags.map((e) => e.toJson()).toList();

  /// Records a damage report captured on [DamagedBoxScreen], entirely local —
  /// no network call on this path at all, so it works exactly the same
  /// whether the terminal is online or not. [flushDamagedFlags] is what
  /// eventually gets it to the server.
  void addDamagedFlag({required String barcode, required List<String> rfidEpcs, String note = ''}) {
    damagedFlags.insert(
      0,
      DamagedFlag(
        id: '${DateTime.now().microsecondsSinceEpoch}-${_rnd.nextInt(1 << 32)}',
        barcode: barcode,
        rfidEpcs: rfidEpcs,
        note: note,
        createdAt: DateTime.now(),
      ),
    );
    _saveDamagedFlags();
    notifyListeners();
  }

  /// Same shape as [flushOutbox]: try every unsynced report, keep whatever
  /// still fails queued for next time, toast the outcome. Synced entries
  /// stay in the list (marked synced) rather than being removed — the
  /// operator's own "แจ้งแล้ว" history on this device shouldn't disappear
  /// the moment it reaches the server.
  Future<void> flushDamagedFlags() async {
    final pending = damagedFlags.where((f) => !f.synced).toList();
    if (pending.isEmpty) return;
    int done = 0;
    for (final flag in pending) {
      try {
        await api.flagDamage(flag.barcode, rfidEpcs: flag.rfidEpcs, note: flag.note);
        final i = damagedFlags.indexWhere((f) => f.id == flag.id);
        if (i >= 0) damagedFlags[i] = damagedFlags[i].copyWith(synced: true);
        done++;
      } catch (_) {
        // Left unsynced — the next connectivity-restore or manual retry
        // (see the outbox banner's own "sync now") tries it again.
      }
    }
    _saveDamagedFlags();
    if (done > 0) toastMsg('ซิงก์รายงานความเสียหายแล้ว', '$done รายการ', ResultKind.ok);
    notifyListeners();
  }

  /// Damage flagging works offline by design (see [addDamagedFlag]), so
  /// unlike box registration this menu item is never hidden or guarded —
  /// there's nothing here that requires a live connection to complete.
  void goDamagedBox() {
    screen = Screen.damagedBox;
    notifyListeners();
    _connectReader();
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
        conditions: tx.conditions,
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
    // ทะเบียนรถ is mandatory only on the way out — the server's gateInSchema
    // already takes it as optional (see backend/src/validators/schemas.ts),
    // this just stopped matching that on the Gate In side of the app.
    if (mode == 'out' && outPlate.trim().isEmpty) {
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
            conditions: Map.of(queueConditions),
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

    // Real connectivity, not a manual toggle — queuing while this says
    // "connected" but a request still fails is covered by the catch block
    // below, which falls back to the same outbox.
    if (!connected) {
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
          conditions: queueConditions,
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
        toastMsg('รับคืนสำเร็จ', '$nw ใหม่ · $rt คืน → $whNm', ResultKind.ok);
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
    queueConditions.clear();
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

  void setOutPlate(String v) {
    outPlate = v;
    notifyListeners();
  }

  void setOutDriver(String v) => outDriver = v;
  void setOutVehicleType(String v) {
    outVehicleType = v;
    if (v != 'อื่นๆ') outVehicleTypeOther = '';
    notifyListeners();
  }

  void setOutVehicleTypeOther(String v) => outVehicleTypeOther = v;
  void setInPlate(String v) {
    inPlate = v;
    notifyListeners();
  }

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
    // Live suggestions (see trackSuggestions) are a getter evaluated at
    // build time — nothing rebuilds TrackScreen to re-read it without this.
    // Was missing entirely, which meant the "as soon as the first character
    // lands" typeahead this method exists for had never actually fired.
    notifyListeners();
  }

  // Bumped on every doTrack() call (and on leaving the screen) so a network
  // reply that lands after a newer search has already started — fast
  // repeated scans, or someone typing over a pending lookup — can't clobber
  // trackTag/trackError with a stale result.
  int _trackSeq = 0;

  /// Resolves [trackVal] to a box. [resolveTag] + [StateSnapshot.box] only
  /// ever matches a box's own barcode tag — S.boxesRaw is keyed by tag
  /// alone — so an RFID read (EPC or TID) never matches there even for a
  /// box that really is registered and tagged. When the local snapshot
  /// comes up empty this falls back to GET /api/boxes/:code, which resolves
  /// against tag/rfid_epc/rfid_tid server-side (services/rfid.ts) — the
  /// same lookup gate.ts itself uses — so "not found" only fires once
  /// neither the local snapshot nor the backend knows the box. A network
  /// failure is kept distinct from a genuine not-found via [trackError], so
  /// a connectivity blip can't be misread as "this box doesn't exist."
  Future<void> doTrack() async {
    final raw = trackVal.trim();
    if (raw.isEmpty) {
      _trackSeq++;
      trackTag = '';
      trackTried = false;
      trackSearching = false;
      trackError = null;
      notifyListeners();
      return;
    }
    final seq = ++_trackSeq;
    trackError = null;
    final localTag = resolveTag(raw);
    if (S?.box(localTag) != null) {
      // Instant path — most searches are a barcode that's already in the
      // local snapshot, no need to round-trip to the backend for those.
      trackTag = localTag;
      trackTried = true;
      trackSearching = false;
      notifyListeners();
      return;
    }

    trackTag = localTag;
    trackTried = true;
    trackSearching = true;
    notifyListeners();
    try {
      final data = await api.getBox(raw);
      if (seq != _trackSeq) return; // superseded by a newer search
      if (data != null) {
        final tag = (data['tag'] ?? raw).toString();
        // Fold it into the local snapshot too so the rest of the UI (which
        // reads purely off S) has it without waiting for the next periodic
        // /api/state refresh.
        S?.boxesRaw[tag] = data;
        trackTag = tag;
      }
    } catch (e) {
      if (seq != _trackSeq) return;
      trackError = 'ค้นหากล่องไม่สำเร็จ — ${_msg(e)}';
    } finally {
      if (seq == _trackSeq) trackSearching = false;
      notifyListeners();
    }
  }

  Box? get trackBox => (trackTried && S != null) ? S!.box(trackTag) : null;

  /// Live typeahead for the track search box — every tag containing what's
  /// typed so far, updated on every keystroke rather than waiting for Enter.
  /// Capped at 20: a match list longer than a PDA screen can show at once
  /// isn't narrowing anything down yet, just more to scroll past.
  List<String> get trackSuggestions {
    final s = S;
    final q = trackVal.trim().toLowerCase();
    if (s == null || q.isEmpty) return const [];
    // No cap — a search for a short/common substring can genuinely match a
    // hundred boxes, and the grid this feeds (see TrackScreen._suggestions)
    // is built to show all of them rather than silently truncating to 20.
    return s.boxesRaw.keys.where((k) => k.toLowerCase().contains(q)).toList()..sort();
  }

  void selectTrackSuggestion(String tag) {
    trackVal = tag;
    doTrack();
  }

  // ═══════════════════════ settings ════════════════════════════════════════
  /// Applies the terminal's connection details and re-authenticates. The
  /// service credentials are the device's own — an operator never sees them,
  /// which is the whole point of badging in instead of signing in.
  Future<void> applyConnection({
    required String baseUrl,
    String? username,
    String? password,
    String? apiKey,
  }) async {
    prefs.baseUrl = baseUrl.trim();
    if (username != null && username.trim().isNotEmpty) prefs.username = username.trim();
    if (password != null && password.isNotEmpty) prefs.password = password;
    if (apiKey != null) prefs.apiKey = apiKey.trim();
    prefs.token = null;
    api
      ..baseUrl = prefs.baseUrl
      ..apiKey = prefs.apiKey
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

  /// The device-setup screen's single bottom button: connects with whatever
  /// is currently in the form, then finishes setup regardless of whether
  /// that connection attempt actually succeeded. The config (base URL,
  /// device credentials) is already saved to prefs by [applyConnection]
  /// before it even tries the network — a terminal being provisioned at a
  /// site whose server happens to be down (or that isn't reachable from
  /// wherever setup is being done) must not be stuck on this screen
  /// forever; it should walk in offline, same as any other cold boot with a
  /// server outage, and pick up the connection the moment the network/server
  /// comes back (see AppController.init's cached-snapshot-first bootstrap
  /// and _onRealtimeConnectivity's auto-reconnect). [applyConnection] has
  /// already toasted success or failure, so no extra failure messaging here.
  Future<void> completeDeviceSetup({
    required String baseUrl,
    String? username,
    String? password,
    String? apiKey,
  }) async {
    await applyConnection(baseUrl: baseUrl, username: username, password: password, apiKey: apiKey);
    finishDeviceSetup();
  }

  // ═══════════════════════ Zebra reader wiring ═════════════════════════════
  bool _readerHooked = false;
  void _connectReader() {
    if (!rfid.supported) return;
    if (_readerHooked && rfid.state == RfidState.connected) return;
    _readerHooked = true;
    rfid.connect();
  }

  /// Stray-read filter: RFID reads through cardboard and thin stock easily
  /// enough that a sweep aimed at one pallet picks up tags on the pallet
  /// next to it. When Prefs.rfidMinRssi is set, a read weaker than that
  /// threshold never reaches addScan/doTrack/badge matching at all — the
  /// same knob a Settings-screen slider drives (see settings_screen.dart).
  void _onReaderBatch(List<RfidTagRead> batch) {
    final minRssi = prefs.rfidMinRssi;
    for (final r in batch) {
      if (minRssi != null && r.rssi != null && r.rssi! < minRssi) continue;
      _onReaderTag(r.epc);
    }
  }

  void _onReaderTag(String epc) {
    switch (screen) {
      case Screen.scan:
        addScan(epc, viaRfid: true);
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
    if (!pressed) {
      // Always safe, and necessary: if the screen changed while the trigger
      // was still physically held (navigating away mid-press), the reader
      // must not keep scanning in the background on a screen that has no
      // business reading tags. Stopping is never gated on which screen this
      // is — only starting is.
      rfid.stopInventory();
      return;
    }
    if (screen != Screen.scan &&
        screen != Screen.track &&
        screen != Screen.login &&
        screen != Screen.rfidInput &&
        screen != Screen.rfidRegister &&
        screen != Screen.rfidLocate &&
        screen != Screen.boxRegister) {
      // A screen with no scanning purpose at all (Home, device setup, …).
      // The antenna must not light up here — silently doing nothing left an
      // operator assuming a broken trigger, not a screen that was never
      // going to answer it. Settings is the one exception: its own
      // test-fire button (settings_screen.dart's press-and-hold "กดค้างเพื่อ
      // ทดสอบยิง") talks to the reader directly rather than through this
      // dispatcher, precisely so a range check doesn't trip this same
      // "wrong screen" alert.
      if (screen != Screen.settings) {
        toastMsg('หน้านี้ไม่รองรับการยิงบาร์โค้ด/RFID', 'สลับไปหน้าที่ใช้งานได้ก่อน', ResultKind.warn);
      }
      return;
    }
    // บาร์โค้ด mode selected on a dual-mode screen: the physical trigger
    // does nothing at all — no read, no beep, no vibration. Previously the
    // toggle only hid the barcode field in the UI; the reader itself still
    // started and beeped on every read because this dispatcher never knew
    // which mode was selected. RfidLocateScreen forces scanInputMode back
    // to rfid the moment a target is picked (its .locate step has no
    // barcode alternative), so this only ever blocks its pick step.
    if ((screen == Screen.scan || screen == Screen.track || screen == Screen.rfidLocate) &&
        scanInputMode == ScanInputMode.barcode) {
      toastMsg('อยู่ในโหมดบาร์โค้ด', 'ไกไม่ทำงาน — สลับเป็นโหมด RFID เพื่ออ่านแท็ก', ResultKind.info);
      return;
    }
    // Gate scanning and the box-locate sweep both drive their own feedback
    // instead of the reader's dense per-read tick: Gate's is discrete
    // ok/error tones from addScan() (see playTone calls below); locate's is
    // haptic-only, gated to genuine target matches (see
    // RfidLocateScreen._onBatch) — a beep on every stray read of a
    // neighbouring pallet's tags was exactly the bug this fixes. Every
    // other RFID screen still wants the raw per-read feedback.
    rfid.setAutoBeep(screen != Screen.scan && screen != Screen.rfidLocate);
    rfid.startInventory();
  }

  // ═══════════════════════ derived getters for the UI ══════════════════════
  bool get connected => _liveConnected;

  /// Test-only way to force [connected] without a real network round trip —
  /// production code has exactly one legitimate way to change this
  /// (_syncLiveConnected/_onRealtimeConnectivity, both driven by an actual
  /// server response), which is the whole point of removing the old manual
  /// toggle. Tests still need to simulate "offline" deterministically
  /// without waiting on FakeApi timing.
  @visibleForTesting
  set connectedForTest(bool v) => _liveConnected = v;
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
