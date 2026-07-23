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

  Map<String, dynamic> get location =>
      (raw['location'] is Map) ? Map<String, dynamic>.from(raw['location']) : const {};

  List<Map<String, dynamic>> get history {
    final h = raw['history'];
    if (h is List) {
      return h.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
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
