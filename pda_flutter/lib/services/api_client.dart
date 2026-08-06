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
///
/// Tokens are short-lived (12h by default, see `backend/src/env.ts`), which is
/// shorter than a device stays powered on at a gate. Rather than surfacing a
/// mid-shift expiry as "บันทึกไม่สำเร็จ", every authenticated request runs
/// through [_send], which re-authenticates once via [reauthenticate] on a 401
/// and replays the request with the fresh token.
class ApiClient {
  String baseUrl;
  String? token;

  /// Second, independent factor the backend can require alongside the JWT
  /// (see backend/src/middleware/auth.ts's requireApiKey) — sent whenever
  /// non-empty, harmless to leave blank against a backend that hasn't set
  /// API_KEY (the header is simply ignored there).
  String? apiKey;

  /// Re-authenticates with the device's own service credentials and stores the
  /// new token on this client. Returns true when a usable token was obtained.
  /// Wired up by AppController; left null in tests that don't need it.
  Future<bool> Function()? reauthenticate;

  ApiClient({required this.baseUrl, this.token, this.apiKey});

  Uri _u(String path) {
    final b = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    return Uri.parse('$b$path');
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null && token!.isNotEmpty) 'Authorization': 'Bearer $token',
        if (apiKey != null && apiKey!.isNotEmpty) 'X-API-Key': apiKey!,
      };

  dynamic _decode(http.Response r) {
    dynamic body;
    try {
      body = r.body.isEmpty ? null : jsonDecode(r.body);
    } catch (_) {
      body = null;
    }
    if (r.statusCode >= 200 && r.statusCode < 300) return body;
    // The Express error middleware sends `{ error: <code>, message: <Thai text> }`
    // — `message` is what should be shown to the user, `error` is the machine code.
    final msg = (body is Map && body['message'] != null)
        ? body['message'].toString()
        : (body is Map && body['error'] != null)
            ? body['error'].toString()
            : 'HTTP ${r.statusCode}';
    final code = (body is Map) ? body['error']?.toString() : null;
    throw ApiException(r.statusCode, msg, code);
  }

  static const _timeout = Duration(seconds: 20);

  /// True while a [reauthenticate] round-trip is in flight, so the login call
  /// it makes can't recurse back into another refresh attempt.
  bool _refreshing = false;

  /// Runs [send] with the current headers; on a 401 refreshes the token once
  /// and runs it again. [send] is a closure rather than a prepared request so
  /// the retry picks up the *new* token instead of replaying the stale one.
  Future<dynamic> _send(Future<http.Response> Function() send) async {
    final r = await send().timeout(_timeout);
    if (r.statusCode != 401 || _refreshing || reauthenticate == null) return _decode(r);

    _refreshing = true;
    bool refreshed;
    try {
      refreshed = await reauthenticate!();
    } catch (_) {
      refreshed = false;
    } finally {
      _refreshing = false;
    }
    if (!refreshed) return _decode(r); // throws the original 401
    return _decode(await send().timeout(_timeout));
  }

  Future<bool> health() async {
    try {
      final r = await http.get(_u('/api/health')).timeout(_timeout);
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// POST /api/auth/login -> { token, user }
  ///
  /// Deliberately outside [_send]: a 401 here means the credentials are wrong,
  /// and retrying them would just fail identically.
  Future<Map<String, dynamic>> login(String username, String password) async {
    final r = await http
        .post(_u('/api/auth/login'),
            headers: _headers, body: jsonEncode({'username': username, 'password': password}))
        .timeout(_timeout);
    final body = _decode(r) as Map<String, dynamic>;
    token = body['token'] as String?;
    return body;
  }

  /// GET /api/state -> full S snapshot
  Future<Map<String, dynamic>> getState() async =>
      await _send(() => http.get(_u('/api/state'), headers: _headers)) as Map<String, dynamic>;

  /// PUT /api/state -> replace whole state (used by the demo seed)
  Future<void> putState(Map<String, dynamic> state) async {
    await _send(() => http.put(_u('/api/state'), headers: _headers, body: jsonEncode(state)));
  }

  /// POST /api/gate/in { tags, gate, employeeId, recorder, plate?, driver?,
  /// vehicleType?, conditions? } — [conditions] flags individual tags as
  /// 'hold' or 'damage' instead of landing on 'warehouse' (see the queue's
  /// per-box condition dropdown in ScanScreen).
  Future<Map<String, dynamic>> gateIn({
    required List<String> tags,
    required int gate,
    String? employeeId,
    String? recorder,
    String? plate,
    String? driver,
    String? vehicleType,
    Map<String, String>? conditions,
  }) async {
    return await _send(() => http.post(_u('/api/gate/in'),
        headers: _headers,
        body: jsonEncode({
          'tags': tags,
          'gate': gate,
          if (employeeId != null && employeeId.isNotEmpty) 'employeeId': employeeId,
          if (recorder != null) 'recorder': recorder,
          if (plate != null && plate.isNotEmpty) 'plate': plate,
          if (driver != null && driver.isNotEmpty) 'driver': driver,
          if (vehicleType != null && vehicleType.isNotEmpty) 'vehicleType': vehicleType,
          if (conditions != null && conditions.isNotEmpty) 'conditions': conditions,
        }))) as Map<String, dynamic>;
  }

  /// POST /api/gate/out { tags, customer, gate, doNo?, po?, employeeId, recorder, … }
  Future<Map<String, dynamic>> gateOut({
    required List<String> tags,
    required String customer,
    required int gate,
    String? doNo,
    String? po,
    String? employeeId,
    String? recorder,
    String? plate,
    String? driver,
    String? vehicleType,
  }) async {
    return await _send(() => http.post(_u('/api/gate/out'),
        headers: _headers,
        body: jsonEncode({
          'tags': tags,
          'customer': customer,
          'gate': gate,
          if (doNo != null) 'doNo': doNo,
          if (po != null) 'po': po,
          if (employeeId != null && employeeId.isNotEmpty) 'employeeId': employeeId,
          if (recorder != null) 'recorder': recorder,
          if (plate != null && plate.isNotEmpty) 'plate': plate,
          if (driver != null && driver.isNotEmpty) 'driver': driver,
          if (vehicleType != null && vehicleType.isNotEmpty) 'vehicleType': vehicleType,
        }))) as Map<String, dynamic>;
  }

  /// GET /api/boxes/:code — code may be a barcode or an RFID EPC/TID; the
  /// backend resolves whichever it turns out to be (see services/rfid.ts).
  Future<Map<String, dynamic>?> getBox(String code) async {
    final r = await http.get(_u('/api/boxes/$code'), headers: _headers).timeout(_timeout);
    if (r.statusCode == 404) return null;
    return _decode(r) as Map<String, dynamic>;
  }

  /// POST /api/boxes/:tag/rfid { rfidTid, rfidEpc, replace? } — attach (or,
  /// with replace:true, re-attach after a damaged tag swap) an RFID tag to
  /// an already-registered box. Throws [ApiException] with code
  /// 'rfid_tid_in_use' or 'already_tagged' for the two conflict cases the
  /// caller may want to handle specially (see services/rfid.ts).
  /// [rfidTid] is optional because the MC3390R's inventory rounds never carry
  /// a TID, and the access-read that could fetch one has to stop and restart
  /// inventory — which is what stopped registration reading tags at all. The
  /// EPC alone identifies the tag; the server treats whichever identifiers it
  /// is given as the tag's identity.
  Future<Map<String, dynamic>> associateRfid(
    String tag, {
    required String rfidEpc,
    String? rfidTid,
    bool replace = false,
  }) async {
    return await _send(() => http.post(_u('/api/boxes/$tag/rfid'),
        headers: _headers,
        body: jsonEncode({
          if (rfidTid != null) 'rfidTid': rfidTid,
          'rfidEpc': rfidEpc,
          'replace': replace,
        }))) as Map<String, dynamic>;
  }

  /// POST /api/boxes { tag, type, lot?, expiry? } — registers a brand-new box
  /// straight off a supplier delivery (status 'pending', not yet labeled).
  /// [lot]/[expiry] are optional free text (scanned or typed) that round-trip
  /// straight into the box's data — the web app's print-label flow already
  /// renders them when present. Throws [ApiException] with code 'tag_taken'
  /// if the barcode is already in use, or 'unknown_box_type' if [type] isn't
  /// a box type on file.
  Future<Map<String, dynamic>> createBox(String tag, {required String type, String? lot, String? expiry}) async {
    return await _send(() => http.post(_u('/api/boxes'),
        headers: _headers,
        body: jsonEncode({
          'tag': tag,
          'type': type,
          if (lot != null && lot.isNotEmpty) 'lot': lot,
          if (expiry != null && expiry.isNotEmpty) 'expiry': expiry,
        }))) as Map<String, dynamic>;
  }

  /// POST /api/boxes/:tag/label — confirms the physical barcode sticker is
  /// actually on the box. Throws with code 'already_labeled' if it's
  /// already been confirmed once.
  Future<Map<String, dynamic>> labelBox(String tag) async {
    return await _send(() => http.post(_u('/api/boxes/$tag/label'), headers: _headers)) as Map<String, dynamic>;
  }

  /// POST /api/boxes/:tag/damage — files a damage report captured offline
  /// (see [DamagedFlag] / DamagedBoxScreen), synced once connectivity comes
  /// back (see AppController.flushDamagedFlags).
  ///
  /// NOTE: this route doesn't exist on the backend yet — the client and
  /// local queue are ready, but someone still has to add the matching
  /// Express handler (persist a damage record against [tag], accept
  /// [rfidEpcs] as the batch that was swept alongside it) before a sync
  /// actually lands anywhere. Until then, flushDamagedFlags's calls here
  /// fail like any other unreachable endpoint and simply retry next sync.
  Future<Map<String, dynamic>> flagDamage(
    String tag, {
    required List<String> rfidEpcs,
    required String note,
  }) async {
    return await _send(() => http.post(_u('/api/boxes/$tag/damage'),
        headers: _headers,
        body: jsonEncode({'rfidEpcs': rfidEpcs, 'note': note}))) as Map<String, dynamic>;
  }

  /// POST /api/boxes/:tag/putaway { wh, zone?, rack?, shelf?, slot? } —
  /// places a labeled box on an actual shelf position, moving it to
  /// 'warehouse'. Throws with code 'not_labeled' if [labelBox] hasn't run
  /// yet, or 'box_out' if the box is currently out with a customer.
  Future<Map<String, dynamic>> putawayBox(
    String tag, {
    required String wh,
    String zone = '',
    String rack = '',
    String shelf = '',
    String slot = '',
  }) async {
    return await _send(() => http.post(_u('/api/boxes/$tag/putaway'),
        headers: _headers,
        body: jsonEncode({'wh': wh, 'zone': zone, 'rack': rack, 'shelf': shelf, 'slot': slot}))) as Map<String, dynamic>;
  }

  /// PUT /api/employees/:id/pin { pin } — set/replace an employee's PIN
  /// outright. Used right after a badge scan (first-time setup or a
  /// voluntary change), never as part of a forgot-PIN reset.
  Future<void> setEmployeePin(String employeeId, String pin) async {
    await _send(() => http.put(_u('/api/employees/$employeeId/pin'),
        headers: _headers, body: jsonEncode({'pin': pin})));
  }

  /// PUT /api/employees/:id/last-post { wh, gate } — the warehouse/gate this
  /// employee just confirmed, so their "ล่าสุด" shortcut follows them to
  /// whichever terminal they badge into next instead of staying pinned to
  /// this one device (see Employee.lastWh/lastGate).
  Future<void> setEmployeeLastPost(String employeeId, {required String wh, required String gate}) async {
    await _send(() => http.put(_u('/api/employees/$employeeId/last-post'),
        headers: _headers, body: jsonEncode({'wh': wh, 'gate': gate})));
  }

  /// POST /api/employees/:id/pin/verify { pin } -> { ok, noPinSet? }
  Future<bool> verifyEmployeePin(String employeeId, String pin) async {
    final body = await _send(() => http.post(_u('/api/employees/$employeeId/pin/verify'),
        headers: _headers, body: jsonEncode({'pin': pin}))) as Map<String, dynamic>;
    return body['ok'] == true;
  }

  /// POST /api/employees/:id/pin/reset — mints a 6-digit OTP (5 min TTL) and
  /// emails it to whatever address is on the employee's own record. Returns
  /// {sentTo, expiresAt}; throws if that employee has no email on file.
  Future<Map<String, dynamic>> requestPinReset(String employeeId) async {
    return await _send(() => http.post(_u('/api/employees/$employeeId/pin/reset'), headers: _headers))
        as Map<String, dynamic>;
  }

  /// POST /api/employees/:id/pin/confirm-reset { otp, pin } — the OTP that
  /// arrived by email, plus the new PIN to set once it checks out.
  Future<void> confirmPinReset(String employeeId, {required String otp, required String pin}) async {
    await _send(() => http.post(_u('/api/employees/$employeeId/pin/confirm-reset'),
        headers: _headers, body: jsonEncode({'otp': otp, 'pin': pin})));
  }

  /// POST /api/masters/box-types { id, name } — adds a new box type on the
  /// fly from the "+ เพิ่มใหม่" option in a dropdown, rather than requiring a
  /// separate admin screen first. Throws with code 'duplicate' if [id] is
  /// already in use.
  Future<Map<String, dynamic>> createBoxType(String id, String name) async {
    return await _send(() => http.post(_u('/api/masters/box-types'),
        headers: _headers, body: jsonEncode({'id': id, 'name': name}))) as Map<String, dynamic>;
  }

  /// POST /api/masters/customers { id, name } — same "add on the fly" path
  /// as [createBoxType], for the customer picker on Gate Out.
  Future<Map<String, dynamic>> createCustomer(String id, String name) async {
    return await _send(() => http.post(_u('/api/masters/customers'),
        headers: _headers, body: jsonEncode({'id': id, 'name': name}))) as Map<String, dynamic>;
  }

  /// POST /api/masters/locations { code, wh?, zone?, rack?, shelf?, slot? } —
  /// registers a new Location Master row so a zone/rack/shelf/slot value
  /// typed via a dropdown's "+ เพิ่มใหม่" becomes a real, reusable option
  /// everywhere else that reads the Location Master, not just this one box.
  Future<Map<String, dynamic>> createLocation({
    required String code,
    String? wh,
    String? zone,
    String? rack,
    String? shelf,
    String? slot,
  }) async {
    return await _send(() => http.post(_u('/api/masters/locations'),
        headers: _headers,
        body: jsonEncode({
          'code': code,
          if (wh != null && wh.isNotEmpty) 'wh': wh,
          if (zone != null && zone.isNotEmpty) 'zone': zone,
          if (rack != null && rack.isNotEmpty) 'rack': rack,
          if (shelf != null && shelf.isNotEmpty) 'shelf': shelf,
          if (slot != null && slot.isNotEmpty) 'slot': slot,
        }))) as Map<String, dynamic>;
  }
}
