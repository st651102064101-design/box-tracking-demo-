import 'dart:convert';
import 'package:http/http.dart' as http;

/// Thrown for any non-2xx API response, carrying the backend's Thai message
/// (the Express error middleware returns `{ error, code }`).
class ApiException implements Exception {
  final int status;
  final String message;
  final String? code;
  ApiException(this.status, this.message, [this.code]);
  @override
  String toString() => 'ApiException($status, $message)';
}

/// Thin REST wrapper around the BoxTrace Express backend.
///
/// All endpoints except `/auth` and `/health` require `Authorization: Bearer`.
class ApiClient {
  String baseUrl;
  String? token;

  ApiClient({required this.baseUrl, this.token});

  Uri _u(String path) {
    final b = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    return Uri.parse('$b$path');
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null && token!.isNotEmpty) 'Authorization': 'Bearer $token',
      };

  Future<dynamic> _decode(http.Response r) async {
    dynamic body;
    try {
      body = r.body.isEmpty ? null : jsonDecode(r.body);
    } catch (_) {
      body = null;
    }
    if (r.statusCode >= 200 && r.statusCode < 300) return body;
    final msg = (body is Map && body['error'] != null)
        ? body['error'].toString()
        : 'HTTP ${r.statusCode}';
    final code = (body is Map) ? body['code']?.toString() : null;
    throw ApiException(r.statusCode, msg, code);
  }

  static const _timeout = Duration(seconds: 20);

  Future<bool> health() async {
    try {
      final r = await http.get(_u('/api/health')).timeout(_timeout);
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// POST /api/auth/login -> { token, user }
  Future<Map<String, dynamic>> login(String username, String password) async {
    final r = await http
        .post(_u('/api/auth/login'),
            headers: _headers, body: jsonEncode({'username': username, 'password': password}))
        .timeout(_timeout);
    final body = await _decode(r) as Map<String, dynamic>;
    token = body['token'] as String?;
    return body;
  }

  /// GET /api/state -> full S snapshot
  Future<Map<String, dynamic>> getState() async {
    final r = await http.get(_u('/api/state'), headers: _headers).timeout(_timeout);
    return await _decode(r) as Map<String, dynamic>;
  }

  /// PUT /api/state -> replace whole state (used by the demo seed)
  Future<void> putState(Map<String, dynamic> state) async {
    final r = await http
        .put(_u('/api/state'), headers: _headers, body: jsonEncode(state))
        .timeout(const Duration(seconds: 40));
    await _decode(r);
  }

  /// POST /api/gate/in { tags, gate, recorder }
  Future<Map<String, dynamic>> gateIn({
    required List<String> tags,
    required int gate,
    String? recorder,
  }) async {
    final r = await http
        .post(_u('/api/gate/in'),
            headers: _headers,
            body: jsonEncode({'tags': tags, 'gate': gate, if (recorder != null) 'recorder': recorder}))
        .timeout(_timeout);
    return await _decode(r) as Map<String, dynamic>;
  }

  /// POST /api/gate/out { tags, customer, gate, doNo?, po?, recorder }
  Future<Map<String, dynamic>> gateOut({
    required List<String> tags,
    required String customer,
    required int gate,
    String? doNo,
    String? po,
    String? recorder,
  }) async {
    final r = await http
        .post(_u('/api/gate/out'),
            headers: _headers,
            body: jsonEncode({
              'tags': tags,
              'customer': customer,
              'gate': gate,
              if (doNo != null) 'doNo': doNo,
              if (po != null) 'po': po,
              if (recorder != null) 'recorder': recorder,
            }))
        .timeout(_timeout);
    return await _decode(r) as Map<String, dynamic>;
  }

  /// GET /api/boxes/:tag
  Future<Map<String, dynamic>?> getBox(String tag) async {
    final r = await http.get(_u('/api/boxes/$tag'), headers: _headers).timeout(_timeout);
    if (r.statusCode == 404) return null;
    return await _decode(r) as Map<String, dynamic>;
  }
}
