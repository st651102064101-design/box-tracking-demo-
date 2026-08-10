/// A returnable box/asset. Wraps the raw JSON object from `GET /api/state`
/// (the same shape the legacy desktop app and the PDA mockup use) and exposes
/// typed accessors for the fields the UI needs.
class Box {
  final Map<String, dynamic> raw;
  Box(this.raw);

  String get tag => (raw['tag'] ?? '').toString();
  String? get type => raw['type']?.toString();
  String get status => (raw['status'] ?? 'pending').toString();
  int get cycles => _int(raw['cycles']);
  String get customer => (raw['customer'] ?? '').toString();
  String get doNo => (raw['do'] ?? '').toString();
  String get po => (raw['po'] ?? '').toString();
  String? get outWh => raw['outWh']?.toString();
  String? get lastSeenAt => raw['lastSeenAt']?.toString();
  String? get dueAt => raw['dueAt']?.toString();
  String? get rfidTid => raw['rfidTid']?.toString();
  String? get rfidEpc => raw['rfidEpc']?.toString();

  /// The single identifier a box is bound by today — `boxes.rfid` on the
  /// backend, written by POST /api/boxes/:tag/rfid, which also clears the
  /// older `rfidEpc`/`rfidTid` pair. Reading only that pair (as every call
  /// site here used to) meant a box tagged through the current endpoint
  /// looked untagged to this app: an RFID read resolved to nothing and the
  /// scan came back "ไม่พบกล่องนี้ในระบบ" even though the web app showed the
  /// tag right there on the box. The legacy pair stays as a fallback for
  /// rows written before `rfid` existed.
  String? get rfid => raw['rfid']?.toString();
  String? get rfidCode {
    for (final v in [rfid, rfidEpc, rfidTid]) {
      if (v != null && v.isNotEmpty) return v;
    }
    return null;
  }

  bool get hasRfid => rfidCode != null;

  Map<String, dynamic> get location => (raw['location'] is Map)
      ? Map<String, dynamic>.from(raw['location'])
      : const {};

  /// The warehouse this box currently belongs to, best-effort. `location.wh`
  /// when it has one (shelved), otherwise the `wh` off its most recent
  /// inbound history entry — a box received in "รอ Putaway" (deferred)
  /// mode reaches `status == 'warehouse'` without ever getting a location
  /// stamped, so `location['wh']` alone under-reports which boxes are
  /// actually this warehouse's. Empty string means genuinely unknown (never
  /// received at all), not "warehouse ''" — callers should treat that as
  /// "don't know, don't block" rather than a mismatch.
  String get currentWh {
    final locWh = location['wh']?.toString();
    if (locWh != null && locWh.isNotEmpty) return locWh;
    for (final h in history.reversed) {
      if (h['dir'] == 'in' || h['dir'] == 'in-new') {
        final w = h['wh']?.toString();
        if (w != null && w.isNotEmpty) return w;
      }
    }
    return '';
  }

  List<Map<String, dynamic>> get history {
    final h = raw['history'];
    if (h is List) {
      return h
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
    }
    return const [];
  }

  /// A box counts as a "return" (not brand-new) once it has ever been shipped.
  bool get everShipped => history.any((h) => h['dir'] == 'out');

  static int _int(dynamic v) {
    if (v == null) return 0;
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse(v.toString()) ?? 0;
  }
}
