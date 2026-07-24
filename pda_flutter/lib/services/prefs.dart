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

  String get baseUrl {
    final saved = _p.getString(_kBaseUrl);
    if (saved != null) return saved;
    // 10.0.2.2 is the Android-emulator-only alias for the host machine — a
    // real browser can never resolve it, so a fresh web visit with no saved
    // setting would otherwise fail to connect before the operator ever gets
    // a chance to open Settings. The page's own origin is always reachable
    // from itself, so default to that on web instead; Android keeps the
    // emulator-friendly default since kIsWeb is false there.
    if (kIsWeb) return Uri.base.origin;
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
