import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:shared_preferences/shared_preferences.dart';

/// Persistent settings & session storage.
///
/// Everything here belongs to the *device*, not to a person: the service
/// account it authenticates with, the gate it is stationed at, and a cached
/// copy of the last known warehouse state. Operators identify themselves by
/// badge at the start of every session and are deliberately never persisted —
/// re-badging takes a second, whereas a stale "who is logged in" survives a
/// crash and silently mis-attributes the next person's scans.
class Prefs {
  final SharedPreferences _p;
  Prefs(this._p);

  static Future<Prefs> load() async => Prefs(await SharedPreferences.getInstance());

  // connection / device account
  static const _kBaseUrl = 'boxtrace_base_url';
  static const _kUsername = 'boxtrace_username';
  static const _kPassword = 'boxtrace_password';
  static const _kToken = 'boxtrace_token';

  // this device's fixed post (warehouse + gate) and behaviour
  static const _kDeviceWh = 'boxtrace_device_wh';
  static const _kDeviceGate = 'boxtrace_device_gate';
  static const _kIdleLock = 'boxtrace_idle_lock_minutes';

  static const _kStateCache = 'boxtrace_state_cache';
  static const _kOutbox = 'boxtrace_pda_outbox';
  static const _kLang = 'boxtrace_lang';
  static const _kDark = 'boxtrace_dark';

  // the last คลัง/ทิศทาง/ประตู actually picked from the home screen — a
  // per-*person* shortcut, unlike deviceWh/deviceGate above which are fixed
  // properties of the terminal itself. Persisted (not just in-memory) so the
  // "ล่าสุด" card still remembers after the app restarts.
  static const _kLastMode = 'boxtrace_last_mode';
  static const _kLastWh = 'boxtrace_last_wh';
  static const _kLastGate = 'boxtrace_last_gate';

  String get lang => _p.getString(_kLang) ?? 'th';
  set lang(String v) => _p.setString(_kLang, v);

  bool get darkMode => _p.getBool(_kDark) ?? false;
  set darkMode(bool v) => _p.setBool(_kDark, v);

  /// Baked in at build time so a device build ships pointing at the right host
  /// without an operator having to type a URL on a handheld keypad:
  ///   flutter build apk --dart-define=BOXTRACE_API_BASE=http://192.168.3.128:4000
  /// Empty (the default) falls through to the per-platform guesses below.
  static const _compiledBaseUrl =
      String.fromEnvironment('BOXTRACE_API_BASE', defaultValue: '');

  String get baseUrl {
    final saved = _p.getString(_kBaseUrl);
    if (saved != null) return saved;
    if (_compiledBaseUrl.isNotEmpty) return _compiledBaseUrl;
    // 10.0.2.2 is the Android-emulator-only alias for the host machine — a
    // real browser can never resolve it, so a fresh web visit with no saved
    // setting would otherwise fail to connect before the operator ever gets
    // a chance to open Settings. Android keeps the emulator-friendly default
    // since kIsWeb is false there.
    if (kIsWeb) {
      final b = Uri.base;
      // Served from the backend itself (same origin, default or API port) —
      // the origin already answers /api, so keep it. Anything else (notably
      // `flutter run`'s dev server on its own port) has to be pointed at the
      // backend's port explicitly or every request 404s on the dev server.
      if (b.port == 4000 || !b.hasPort || b.port == 80 || b.port == 443) {
        return b.origin;
      }
      return '${b.scheme}://${b.host}:4000';
    }
    return 'http://10.0.2.2:4000';
  }

  set baseUrl(String v) => _p.setString(_kBaseUrl, v);

  /// The device's own service account. Typed once by whoever hands out the
  /// terminal — never by an operator, who signs in with a badge instead.
  String get username => _p.getString(_kUsername) ?? 'admin';
  set username(String v) => _p.setString(_kUsername, v);

  String get password => _p.getString(_kPassword) ?? 'admin123';
  set password(String v) => _p.setString(_kPassword, v);

  String? get token => _p.getString(_kToken);
  set token(String? v) => v == null ? _p.remove(_kToken) : _p.setString(_kToken, v);

  /// The warehouse + gate this terminal is stationed at. A non-empty gate is
  /// what marks the device as provisioned (see AppController.deviceConfigured).
  String get deviceWh => _p.getString(_kDeviceWh) ?? '';
  set deviceWh(String v) => _p.setString(_kDeviceWh, v);

  String get deviceGate => _p.getString(_kDeviceGate) ?? '';
  set deviceGate(String v) => _p.setString(_kDeviceGate, v);

  /// Minutes of inactivity before the operator is signed out. 0 disables it.
  int get idleLockMinutes => _p.getInt(_kIdleLock) ?? 10;
  set idleLockMinutes(int v) => _p.setInt(_kIdleLock, v);

  /// Empty means "nothing picked yet" — the "ล่าสุด" shortcut stays hidden
  /// until a real คลัง/ทิศทาง/ประตู combination has been used at least once.
  String get lastMode => _p.getString(_kLastMode) ?? '';
  set lastMode(String v) => _p.setString(_kLastMode, v);

  String get lastWh => _p.getString(_kLastWh) ?? '';
  set lastWh(String v) => _p.setString(_kLastWh, v);

  String get lastGate => _p.getString(_kLastGate) ?? '';
  set lastGate(String v) => _p.setString(_kLastGate, v);

  /// Last known `S` snapshot. Restored before the network call on boot so the
  /// badge screen has employee names — and the scanner has box data — even
  /// when the backend is unreachable at start-up.
  Map<String, dynamic>? get stateCache {
    final s = _p.getString(_kStateCache);
    if (s == null) return null;
    try {
      return Map<String, dynamic>.from(jsonDecode(s));
    } catch (_) {
      return null;
    }
  }

  set stateCache(Map<String, dynamic>? v) =>
      v == null ? _p.remove(_kStateCache) : _p.setString(_kStateCache, jsonEncode(v));

  List<dynamic> get outbox {
    final s = _p.getString(_kOutbox);
    if (s == null) return [];
    try {
      return List<dynamic>.from(jsonDecode(s));
    } catch (_) {
      return [];
    }
  }

  set outbox(List<dynamic> v) => _p.setString(_kOutbox, jsonEncode(v));
}
