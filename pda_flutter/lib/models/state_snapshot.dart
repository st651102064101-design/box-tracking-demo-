import 'box.dart';

/// Typed view over the full `S` snapshot returned by `GET /api/state`.
///
/// The backend round-trips the exact object the legacy UI used, so we parse the
/// same maps: boxes / customers / boxtypes / warehouses / gates / employees /
/// events / cfg. Everything is kept nullable-safe and falls back to empty.
class StateSnapshot {
  final Map<String, dynamic> boxesRaw;
  final Map<String, dynamic> customers;
  final Map<String, dynamic> boxtypes;
  final Map<String, dynamic> warehouses;
  final Map<String, String> gates; // gateNo -> warehouseId
  final Map<String, dynamic> employees;
  final List<dynamic> events;
  final Map<String, dynamic> cfg;

  /// `code -> {wh, zone, rack, shelf, slot, type, note, ...}` — the master
  /// rack/shelf/slot list a warehouse admin defines up front (see backend's
  /// `locations` table), not just wherever a box happens to have landed.
  final Map<String, dynamic> locations;

  StateSnapshot({
    required this.boxesRaw,
    required this.customers,
    required this.boxtypes,
    required this.warehouses,
    required this.gates,
    required this.employees,
    required this.events,
    required this.cfg,
    required this.locations,
  });

  factory StateSnapshot.fromJson(Map<String, dynamic> j) {
    Map<String, dynamic> m(dynamic v) =>
        v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
    final gatesRaw = m(j['gates']);
    return StateSnapshot(
      boxesRaw: m(j['boxes']),
      customers: m(j['customers']),
      boxtypes: m(j['boxtypes']),
      warehouses: m(j['warehouses']),
      gates:
          gatesRaw.map((k, v) => MapEntry(k.toString(), (v ?? '').toString())),
      employees: m(j['employees']),
      events:
          (j['events'] is List) ? List<dynamic>.from(j['events']) : const [],
      cfg: m(j['cfg']),
      locations: m(j['locations']),
    );
  }

  int get boxCount => boxesRaw.length;

  Box? box(String tag) {
    final r = boxesRaw[tag];
    return r is Map ? Box(Map<String, dynamic>.from(r)) : null;
  }

  /// Looks up a box by tag, RFID EPC, or RFID TID — mirrors the backend's
  /// resolveBoxesByCodes (services/rfid.ts), which resolves scans against
  /// all three columns. boxesRaw is keyed by tag only, so RFID scans need
  /// this separate lookup by value.
  String? tagForCode(String code) {
    final direct = boxesRaw[code];
    if (direct is Map) return code;
    final target = code.toLowerCase();
    for (final entry in boxesRaw.entries) {
      final v = entry.value;
      if (v is! Map) continue;
      // `rfid` first — it is what POST /api/boxes/:tag/rfid writes now; the
      // older pair is still matched for rows bound before it existed.
      final rfid = v['rfid']?.toString().toLowerCase();
      final tid = v['rfidTid']?.toString().toLowerCase();
      final epc = v['rfidEpc']?.toString().toLowerCase();
      if (rfid == target || tid == target || epc == target) return entry.key;
    }
    return null;
  }

  Iterable<Box> get boxes => boxesRaw.values
      .whereType<Map>()
      .map((e) => Box(Map<String, dynamic>.from(e)));

  int get warehouseCount => boxes.where((b) => b.status == 'warehouse').length;
  int get outCount => boxes.where((b) => b.status == 'out').length;

  String typeName(String? id) {
    if (id == null) return '-';
    final t = boxtypes[id];
    if (t is Map && t['name'] != null) return t['name'].toString();
    return id;
  }

  String custName(String? id) {
    if (id == null || id.isEmpty) return id ?? '-';
    final c = customers[id];
    if (c is Map && c['name'] != null) return c['name'].toString();
    return id;
  }

  String whName(String? id) {
    if (id == null) return '-';
    final w = warehouses[id];
    if (w is Map && w['name'] != null) return w['name'].toString();
    return id.isEmpty ? '-' : id;
  }

  String gateWh(String? gate) => gate == null ? '' : (gates[gate] ?? '');

  int get agingDays {
    final v = cfg['agingDays'];
    if (v is num) return v.toInt();
    return int.tryParse('${v ?? ''}') ?? 15;
  }

  /// Return-days for a customer, falling back to config aging days.
  int returnDaysFor(String? customerId) {
    final c = customerId == null ? null : customers[customerId];
    if (c is Map && c['returnDays'] is num) {
      return (c['returnDays'] as num).toInt();
    }
    return agingDays;
  }

  List<int> gatesOf(String whId) {
    final w = warehouses[whId];
    if (w is Map && w['gates'] is List) {
      return (w['gates'] as List).map((e) => int.tryParse('$e') ?? 0).toList();
    }
    return const [];
  }

  /// Raw `gateNo -> 'in'|'out'|'both'` map from `warehouses[id].gateTypes`.
  /// A gate absent from the map simply isn't a key here — the UI layer is
  /// what decides to treat that as 'both'.
  Map<String, String> gateTypesOf(String whId) {
    final w = warehouses[whId];
    if (w is Map && w['gateTypes'] is Map) {
      return (w['gateTypes'] as Map)
          .map((k, v) => MapEntry(k.toString(), (v ?? '').toString()));
    }
    return const {};
  }

  /// Every distinct value seen for one location field (zone/rack/shelf/slot)
  /// in [whId] — union of the master [locations] list (what an admin defined
  /// up front) and whatever's actually on a box's own location right now
  /// (a shelf someone's already using that never got added to the master
  /// list shouldn't vanish from the dropdown just because of that). Used to
  /// populate TransferScreen's zone/rack/shelf/slot pickers instead of a
  /// free-typed field with nothing to keep two operators spelling the same
  /// shelf the same way.
  List<String> locationValues(String whId, String field,
      {String? zone, String? rack}) {
    final out = <String>{};
    for (final raw in locations.values) {
      if (raw is! Map) continue;
      if ((raw['wh'] ?? '').toString() != whId) continue;
      if (zone != null && (raw['zone'] ?? '').toString() != zone) continue;
      if (rack != null && (raw['rack'] ?? '').toString() != rack) continue;
      final v = (raw[field] ?? '').toString();
      if (v.isNotEmpty) out.add(v);
    }
    for (final b in boxes) {
      final l = b.location;
      if ((l['wh'] ?? '').toString() != whId) continue;
      if (zone != null && (l['zone'] ?? '').toString() != zone) continue;
      if (rack != null && (l['rack'] ?? '').toString() != rack) continue;
      final v = (l[field] ?? '').toString();
      if (v.isNotEmpty) out.add(v);
    }
    final list = out.toList()..sort();
    return list;
  }

  /// Resolve a scanned/typed location code (the master `locations` table's
  /// own `code`, e.g. a barcode stuck to a rack or shelf) to its
  /// zone/rack/shelf/slot — used by TransferScreen's "scan the shelf
  /// barcode" mode as an alternative to picking each field from a dropdown.
  /// Case-insensitive since barcode labels aren't guaranteed consistent
  /// casing. Null when the code isn't on file for this warehouse.
  Map<String, String>? locationByCode(String whId, String code) {
    final needle = code.trim().toLowerCase();
    if (needle.isEmpty) return null;
    for (final entry in locations.entries) {
      if (entry.key.toLowerCase() != needle) continue;
      final raw = entry.value;
      if (raw is! Map) continue;
      if ((raw['wh'] ?? '').toString() != whId) continue;
      return {
        'zone': (raw['zone'] ?? '').toString(),
        'rack': (raw['rack'] ?? '').toString(),
        'shelf': (raw['shelf'] ?? '').toString(),
        'slot': (raw['slot'] ?? '').toString(),
      };
    }
    return null;
  }
}
