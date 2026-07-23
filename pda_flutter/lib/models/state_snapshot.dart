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

  StateSnapshot({
    required this.boxesRaw,
    required this.customers,
    required this.boxtypes,
    required this.warehouses,
    required this.gates,
    required this.employees,
    required this.events,
    required this.cfg,
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
      gates: gatesRaw.map((k, v) => MapEntry(k.toString(), (v ?? '').toString())),
      employees: m(j['employees']),
      events: (j['events'] is List) ? List<dynamic>.from(j['events']) : const [],
      cfg: m(j['cfg']),
    );
  }

  int get boxCount => boxesRaw.length;
  bool get connected => boxCount > 0;

  Box? box(String tag) {
    final r = boxesRaw[tag];
    return r is Map ? Box(Map<String, dynamic>.from(r)) : null;
  }

  Iterable<Box> get boxes =>
      boxesRaw.values.whereType<Map>().map((e) => Box(Map<String, dynamic>.from(e)));

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
    if (c is Map && c['returnDays'] is num) return (c['returnDays'] as num).toInt();
    return agingDays;
  }

  List<int> gatesOf(String whId) {
    final w = warehouses[whId];
    if (w is Map && w['gates'] is List) {
      return (w['gates'] as List).map((e) => int.tryParse('$e') ?? 0).toList();
    }
    return const [];
  }
}
