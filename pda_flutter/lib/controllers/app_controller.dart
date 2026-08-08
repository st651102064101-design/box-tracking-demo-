import 'dart:async';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show HapticFeedback;

import '../models/box.dart';
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
  transfer,
  cycleCount,
  moreHub,
}

/// Which physical input a trigger pull means right now, on any screen that
/// offers both — Gate scanning, Track, and RfidLocateScreen's own box-pick
/// step. Centralized (not per-screen local state) because the trigger
/// itself is wired centrally too (AppController._onReaderTrigger is the
/// only place a hardware trigger event turns into rfid.startInventory()) —
/// a screen-local toggle that this dispatcher never saw was exactly how a
/// "barcode mode" selection still silently started RFID reads and beeped.
enum ScanInputMode { barcode, rfid }

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
  bool online = true;
  final List<OutboxTx> outbox = [];

  // ── track ───────────────────────────────────────────────────────────────
  String trackVal = '';
  String trackTag = '';
  bool trackTried = false;
  /// Distinct tags found while sweeping in RFID mode on TrackScreen, in the
  /// order first seen. A held trigger reads the same tag dozens of times a
  /// second — only the first read of each tag lands here (see
  /// _onReaderTag's Screen.track case), which is what makes "5 tags in the
  /// pile" resolve to exactly 5 rows instead of a beep/flash storm.
  final List<String> trackRfidHits = [];
  /// Same idea as [trackRfidHits] but for barcode mode: every distinct box a
  /// scan (or a completed typed code) has resolved to, in the order found.
  /// Without this, a keyboard-wedge scanner that doesn't clear the field
  /// between reads left each new scan's characters landing after the
  /// previous one's leftover text — two genuinely different barcodes
  /// concatenating into one garbled search string instead of becoming two
  /// results.
  final List<String> trackBarcodeHits = [];

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
        // Dart which sound to play per read, so it has to be told once here
        // (and again on every change — see setRfidSoundId below).
        rfid.setRfidSoundId(prefs.rfidSoundId);
        rfid.setSoundVolume(prefs.rfidSoundVolume);
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
    await _ensureAuthAndState();
    if (connError != null) _liveConnected = false;
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
    } else {
      // Deliberately left null when nothing more specific is known — the
      // dialog and the reconnect sheet both have their own wording for
      // "just offline", and echoing a generic string here only made the
      // alert repeat its own title back as the body.
      if (wasConnected) offlineEventId++;
    }
    notifyListeners();
  }

  /// Human-readable message for an arbitrary error. Strips the leading
  /// `SomethingException: ` that Dart prepends — matching only at the start so
  /// `ClientException: Failed to fetch` doesn't get mangled into `ClientFailed`.
  String _msg(Object e) {
    if (e is ApiException) return e.message;
    final s = e.toString();
    // A dead/unreachable Base URL surfaces as some flavor of SocketException
    // wrapped inside http's ClientException — verbatim, that's e.g.
    // "ClientException with SocketException: No route to host (OS Error: No
    // route to host, errno = 113), address = 192.168.1.149", which the regex
    // below can't clean up (the wrapper reads "...Exception with Socket...:",
    // not "...Exception: ", so it never matches) and which means nothing to
    // an operator anyway. Same underlying cause — this terminal's network
    // can't currently reach the address in Settings — whatever the exact OS
    // errno, so one Thai message covers all of them.
    if (s.contains('SocketException') ||
        s.contains('No route to host') ||
        s.contains('Network is unreachable') ||
        s.contains('Connection refused') ||
        s.contains('Failed host lookup')) {
      return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบว่าเครื่องนี้อยู่ในเครือข่าย/Wi-Fi เดียวกับเซิร์ฟเวอร์ และ Base URL ในหน้าตั้งค่าถูกต้อง';
    }
    if (e is TimeoutException) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (หมดเวลา) — ลองใหม่อีกครั้ง';
    final m = RegExp(r'^[A-Za-z_]*(Exception|Error): ').firstMatch(s);
    return m == null ? s : s.substring(m.end);
  }

  /// Public entry point for [_msg] — screens whose own try/catch around an
  /// `api.*` call has nowhere else to turn a raw error into the same
  /// operator-facing Thai text `applyConnection`/`_ensureAuthAndState` use
  /// (see login_screen.dart's PIN flows).
  String errorMessage(Object e) => _msg(e);

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

  /// What a tap on the navbar's offline chip or Settings' connection panel
  /// does: try reconnecting with whatever's already saved first (a terminal
  /// that reads "online" (Wi-Fi/LAN up) but can't reach the server needs more
  /// than another silent retry to ever recover), and if that still fails,
  /// walk straight into the ที่อยู่เซิร์ฟเวอร์/บัญชีเครื่อง form (device setup)
  /// so a wrong IP or an expired service account can be fixed on the spot.
  /// A non-supervisor can't get to that form (see [canConfigureDevice]) —
  /// they get told to ask one instead, rather than the tap silently doing
  /// nothing.
  Future<void> reconnectOrConfigure() async {
    final ok = await retryConnection();
    if (ok) return;
    if (canConfigureDevice) {
      goDeviceSetup();
    } else {
      toastMsg('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', connError ?? 'แจ้งหัวหน้างานเพื่อตรวจสอบการตั้งค่าเครื่อง', ResultKind.err);
    }
  }

  /// The navbar chip's tap target. While genuinely disconnected, a tap means
  /// "help me reconnect" (see [reconnectOrConfigure]). While genuinely
  /// connected, a tap now does nothing — the manual online/offline
  /// (queue-mode) toggle it used to also drive let an operator switch a
  /// working connection to "offline" by mistake, silently queuing every
  /// scan instead of sending it. [toggleOnline] itself is untouched (the
  /// outbox banner's "Sync" button still uses it to force a flush), only
  /// this chip's tap while actually online is now a no-op instead of a trap.
  void onlineChipTap() {
    if (connected) return;
    reconnectOrConfigure();
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
    trackVal = '';
    trackTag = '';
    trackTried = false;
    trackRfidHits.clear();
    trackBarcodeHits.clear();
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

  /// Relocate an already-warehoused box — TransferScreen. Reuses the exact
  /// same PUT/POST putawayBox endpoint BoxRegisterScreen's putaway step
  /// calls; the backend already logs a 'relocate' history entry instead of
  /// 'putaway' whenever the box's status is already 'warehouse' (see
  /// track_screen.dart's history rendering for the 'relocate' dir it
  /// expects), so no new API was needed for this screen.
  void goTransfer() {
    screen = Screen.transfer;
    notifyListeners();
  }

  /// Reconciliation sweep over one location — CycleCountScreen. Purely
  /// client-side: there's no cycle-count endpoint on the backend, so this
  /// works entirely off the already-cached box list (S.boxes), comparing
  /// "expected here" against what actually got scanned this session.
  void goCycleCount() {
    screen = Screen.cycleCount;
    notifyListeners();
  }

  /// Hub for the less-frequent floor actions that don't each need their own
  /// slot on Home's primary 6-button menu — RFID tag binding, brand-new box
  /// intake, and the text-search box lookup (Track).
  void goMoreHub() {
    screen = Screen.moreHub;
    notifyListeners();
  }

  void onScanChanged(String v) {
    scanVal = v;
    notifyListeners();
  }

  void submitScan() {
    addScan(scanVal);
  }

  /// [viaRfid] says which of the two independently-configured "a box
  /// landed" sounds to play (see prefs.rfidSoundId/barcodeSoundId) — true
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
    // channel is user-configurable (see prefs.rfidSoundId / setRfidSoundId).
    // A trigger-pulled RFID read landing here still gets the operator's
    // chosen RFID sound rather than this fixed one, so an RFID detection
    // sounds the same everywhere it happens.
    if (viaRfid) {
      rfid.playSound(prefs.rfidSoundId);
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

  /// Always on now — trims animations/gradients/shadows and widens
  /// background-polling intervals everywhere that checks this, on every
  /// device, all the time, for a consistently smooth app rather than
  /// something an operator had to know to switch on. No longer reads
  /// Prefs.lowPowerMode (the toggle that used to drive this is gone from
  /// Settings) or exposes a setter.
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

  // ═══════════════════════ detection sounds ════════════════════════════════
  /// Sets which sound plays when the reader detects an RFID tag, both the
  /// dense per-read tick on RFID-native screens and Gate's discrete
  /// trigger-pulled "new box" tick. Persists, pushes the id down to native
  /// immediately (see rfid_service.dart's setRfidSoundId for why native has
  /// to be told rather than asked each time), and previews it — the
  /// settings picker's whole point is "pick it, hear it, done" in one tap.
  void setRfidSoundId(String id) {
    prefs.rfidSoundId = id;
    rfid.setRfidSoundId(id);
    rfid.playSound(id);
    notifyListeners();
  }

  /// Sets the RFID detection sound's playback level (0.0-1.0). Persists,
  /// pushes it to native the same way [setRfidSoundId] does, and previews at
  /// the new level with whatever sound is currently selected.
  void setRfidSoundVolume(double volume) {
    prefs.rfidSoundVolume = volume;
    rfid.setSoundVolume(volume);
    rfid.playSound(prefs.rfidSoundId);
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
    // Live suggestions (see trackSuggestions) are a getter evaluated at
    // build time — nothing rebuilds TrackScreen to re-read it without this.
    // Was missing entirely, which meant the "as soon as the first character
    // lands" typeahead this method exists for had never actually fired.
    notifyListeners();
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
    // A resolved, real box means this search string was a completed code —
    // typed in full or scanned — not a still-in-progress partial. Log it as
    // a hit (same list-of-results shape RFID mode already uses) and clear
    // the field so the next scan starts clean instead of the wedge's next
    // characters landing after this one's leftover text.
    if (S?.box(trackTag) != null) {
      if (!trackBarcodeHits.contains(trackTag)) trackBarcodeHits.add(trackTag);
      trackVal = '';
    }
    notifyListeners();
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

  /// Opens the full detail card for one tag out of [trackRfidHits] — tapping
  /// a row in the RFID results list. Deliberately doesn't touch trackVal (or
  /// clear trackRfidHits): the barcode field and the RFID sweep results stay
  /// independent, same reasoning as _onReaderTag's Screen.track case.
  void viewTrackHit(String tag) {
    trackTag = tag;
    trackTried = true;
    notifyListeners();
  }

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

  /// The device-setup screen's single bottom button: connects with whatever
  /// is currently in the form, then finishes setup automatically once that
  /// succeeds — an operator no longer has to tap "บันทึก & เชื่อมต่อ" above and
  /// then this button separately, which read as the button being broken when
  /// really it was just gated on a connection nobody had triggered yet. Does
  /// nothing further on failure — [applyConnection] already toasted why.
  Future<void> completeDeviceSetup({
    required String baseUrl,
    String? username,
    String? password,
  }) async {
    await applyConnection(baseUrl: baseUrl, username: username, password: password);
    if (connected) finishDeviceSetup();
  }

  // ═══════════════════════ Zebra reader wiring ═════════════════════════════
  bool _readerHooked = false;
  void _connectReader() {
    if (!rfid.supported) return;
    if (_readerHooked && rfid.state == RfidState.connected) return;
    _readerHooked = true;
    rfid.connect();
  }

  /// Pushes the reader's transmit power to its own maximum — for any screen
  /// whose whole point is finding/detecting tags as reliably as possible
  /// (RfidLocateScreen's sweep, TrackScreen's RFID mode). More power is the
  /// one lever that actually helps a weak-signal tag get decoded at all,
  /// not just read louder — a stray "ใกล้/ปานกลาง" pick left over from
  /// Settings would otherwise silently cap range on a screen that needs
  /// every bit of it. Safe to call repeatedly; each call re-reads the
  /// reader's own max index rather than assuming a cached one still applies.
  Future<void> forceMaxRfidPower() async {
    if (!rfid.supported) return;
    final d = await rfid.diagnostics();
    final maxIdx = d['powerMaxIndex'];
    if (maxIdx is int) {
      prefs.rfidPowerPercent = 100;
      await rfid.setPowerIndex(maxIdx);
    }
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
        // Accumulate distinct tags rather than resolving straight to a
        // single box (the old behavior) — a sweep over a pile of boxes
        // should list every tag found, not keep overwriting one result with
        // whichever tag the reader last happened to see. trackVal is
        // deliberately left untouched: it's the barcode field's own state,
        // and populating it from an RFID read is what used to leak the last
        // tag number into the barcode box after switching modes.
        final tag = resolveTag(epc);
        if (!trackRfidHits.contains(tag)) {
          trackRfidHits.add(tag);
          rfid.playSound(prefs.rfidSoundId);
          notifyListeners();
        }
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
    if (screen == Screen.login) {
      // Badge-in is barcode-only: a printed badge scans through the
      // handheld's own keyboard-wedge/imager, which fires off the same
      // physical trigger button independently of this SDK. This handler
      // must never also switch that button over to an RFID sweep here —
      // that was firing the antenna alongside every barcode scan, which is
      // exactly the "close RFID find mode, trigger only reads barcodes"
      // behavior this screen is supposed to have. Nothing to toast: the
      // trigger did its job via the imager, this handler just isn't part
      // of that path on this screen.
      return;
    }
    if (screen != Screen.scan &&
        screen != Screen.track &&
        screen != Screen.rfidInput &&
        screen != Screen.rfidRegister &&
        screen != Screen.rfidLocate &&
        screen != Screen.boxRegister &&
        screen != Screen.settings) {
      // A screen with no scanning purpose at all (Home, device setup, …).
      // Settings is included here — its RFID diagnostics panel has its own
      // "กดค้างเพื่อทดสอบยิง" hold button, but an operator standing there and
      // pulling the *physical* trigger to test the reader should get the
      // same result, not a "this screen doesn't support scanning" toast. The
      // antenna must not light up here — silently doing
      // nothing left an operator assuming a broken trigger, not a screen
      // that was never going to answer it.
      toastMsg('หน้านี้ไม่รองรับการยิงบาร์โค้ด/RFID', '', ResultKind.warn);
      return;
    }
    // บาร์โค้ด mode selected on a dual-mode screen: the physical trigger
    // does nothing at all — no read, no beep, no vibration. Previously the
    // toggle only hid the barcode field in the UI; the reader itself still
    // started and beeped on every read because this dispatcher never knew
    // which mode was selected.
    //
    // rfidLocateSweepStep is what exempts RfidLocateScreen's sweep step:
    // that step has no barcode alternative at all, so gating it on a
    // *shared, app-wide* mode flag meant the trigger silently did nothing
    // there whenever anything else had last left the mode on บาร์โค้ด —
    // including this screen's own pick step, which now deliberately starts
    // in barcode mode. The on-screen "เริ่มกวาดหา" button calls
    // startInventory() directly and never went through here, which is
    // exactly why that button worked while the trigger appeared dead.
    if ((screen == Screen.scan ||
            screen == Screen.track ||
            (screen == Screen.rfidLocate && !rfidLocateSweepStep)) &&
        scanInputMode == ScanInputMode.barcode) {
      toastMsg('อยู่ในโหมดบาร์โค้ด', 'ไกไม่ทำงาน — สลับเป็นโหมด RFID เพื่ออ่านแท็ก', ResultKind.info);
      return;
    }
    if (screen == Screen.boxRegister && !boxRegisterRfidStep) {
      // The create/label/putaway/success steps all expect a *barcode* (the
      // box's own tag, scanned or typed) — only the rfid step's card is
      // asking for a trigger pull. Same class of bug as the login screen
      // fix: this dispatcher used to start an RFID sweep on every trigger
      // pull anywhere on this screen, which meant scanning the box's
      // barcode to create it could also silently arm the antenna. Nothing
      // to toast: the barcode step's own field/imager already answered the
      // trigger, this handler just isn't part of that path yet.
      return;
    }
    if (screen == Screen.rfidRegister && !rfidRegisterRfidStep) {
      // Same reasoning, one step earlier: the waitingBarcode step's own
      // field/imager handles a trigger pull there. RfidRegisterScreen arms
      // the reader itself the instant a barcode resolves (see its
      // _submitBarcode), so this dispatcher isn't even the normal way that
      // screen starts a sweep — but without this gate it would still fire
      // one on every trigger pull during barcode entry too.
      return;
    }
    // Gate scanning, the box-locate sweep, Track's own multi-tag list, and
    // box registration's tag-candidate sweep all drive their own feedback
    // instead of the reader's dense per-read tick: Gate's is discrete
    // ok/error tones from addScan() (see playTone calls below); locate's is
    // haptic-only, gated to genuine target matches (see
    // RfidLocateScreen._onBatch); Track's and box registration's are one
    // sound per newly-found tag (see _onReaderTag's Screen.track case and
    // BoxRegisterScreen._onTagRead). Leaving the native tick on for any of
    // these means a re-read of a tag already handled still beeps — the SDK
    // fires it from its own read callback with no idea a tag is a repeat,
    // only Dart does. Every other RFID screen still wants the raw per-read
    // feedback.
    rfid.setAutoBeep(screen != Screen.scan &&
        screen != Screen.rfidLocate &&
        screen != Screen.track &&
        screen != Screen.boxRegister);
    rfid.startInventory();
  }

  /// True only while BoxRegisterScreen's own rfid step (_Step.rfid) is on
  /// top — see the Screen.boxRegister branch in [_onReaderTrigger] above.
  /// Defaults false so the create/label steps' barcode entry never
  /// accidentally arms the antenna; the screen flips this on entering its
  /// rfid step and back off leaving it (skip, bind, dispose, …).
  bool boxRegisterRfidStep = false;

  /// True only while RfidLocateScreen is on its sweep step (a target box has
  /// been picked). That step is RFID-only by definition, so the trigger must
  /// work there regardless of what [scanInputMode] happens to be set to
  /// app-wide — see the rfidLocate branch in [_onReaderTrigger].
  bool rfidLocateSweepStep = false;

  /// Same idea, for RfidRegisterScreen's own waitingRfid step. That screen
  /// already arms the reader itself the instant a barcode resolves (see its
  /// _submitBarcode — no trigger pull needed there), but the *barcode* step
  /// still needs this false so a trigger pulled while typing/scanning a box
  /// code doesn't also fire the antenna through this dispatcher.
  bool rfidRegisterRfidStep = false;

  // ═══════════════════════ derived getters for the UI ══════════════════════
  bool get connected => _liveConnected;

  /// What the navbar's online/offline chip should actually show — [online]
  /// alone used to drive it, which meant a genuinely dead connection still
  /// displayed "online" until someone happened to tap the chip (it starts
  /// true and nothing else ever turned it false). Real connectivity now
  /// overrides the manual toggle in one direction only: truly offline always
  /// shows offline, but the operator can still use the toggle to go into
  /// offline/queue mode on purpose while [connected] is otherwise true.
  bool get onlineDisplay => online && connected;
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
