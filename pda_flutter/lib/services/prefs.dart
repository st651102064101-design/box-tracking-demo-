import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:shared_preferences/shared_preferences.dart';

/// Persistent settings & session storage. Mirrors the localStorage keys the PDA
/// mockup used, so the two stay conceptually aligned.
class Prefs {
  final SharedPreferences _p;
  Prefs(this._p);

  static Future<Prefs> load() async => Prefs(await SharedPreferences.getInstance());

  // connection / auth
  static const _kBaseUrl = 'boxtrace_base_url';
  static const _kUsername = 'boxtrace_username';
  static const _kPassword = 'boxtrace_password';
  static const _kToken = 'boxtrace_token';

  // shift session (operator + warehouse + gate)
  static const _kSession = 'boxtrace_pda_session';
  static const _kOutbox = 'boxtrace_pda_outbox';

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

  String get username => _p.getString(_kUsername) ?? 'admin';
  set username(String v) => _p.setString(_kUsername, v);

  String get password => _p.getString(_kPassword) ?? 'admin123';
  set password(String v) => _p.setString(_kPassword, v);

  String? get token => _p.getString(_kToken);
  set token(String? v) => v == null ? _p.remove(_kToken) : _p.setString(_kToken, v);

  Map<String, dynamic>? get session {
    final s = _p.getString(_kSession);
    if (s == null) return null;
    try {
      return Map<String, dynamic>.from(jsonDecode(s));
    } catch (_) {
      return null;
    }
  }

  set session(Map<String, dynamic>? v) =>
      v == null ? _p.remove(_kSession) : _p.setString(_kSession, jsonEncode(v));

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
