/// One row of the Location Master (`S.locations`, keyed by `code`).
/// Mirrors the backend's `locations` table / legacy.html's `S.locations` shape.
class Location {
  final String code;
  final String wh;
  final String zone;
  final String rack;
  final String shelf;
  final String slot;

  const Location({
    required this.code,
    required this.wh,
    required this.zone,
    required this.rack,
    required this.shelf,
    required this.slot,
  });

  factory Location.fromJson(String code, Map<String, dynamic> j) {
    String s(dynamic v) => (v ?? '').toString();
    return Location(
      code: code,
      wh: s(j['wh']),
      zone: s(j['zone']),
      rack: s(j['rack']),
      shelf: s(j['shelf']),
      slot: s(j['slot']),
    );
  }
}

/// Cascading Zone → Rack → Shelf → Slot lookups over the Location Master,
/// scoped by warehouse and upstream selections — same logic as legacy.html's
/// locFieldValues()/rebuildLocCascade(), so a rack that doesn't exist can
/// never be picked or typed into a box's location.
class LocationCascade {
  final Map<String, Location> locations;
  const LocationCascade(this.locations);

  List<String> _values(String field, {String? wh, String? zone, String? rack, String? shelf}) {
    final set = <String>{};
    for (final l in locations.values) {
      if (wh != null && wh.isNotEmpty && l.wh != wh) continue;
      if (zone != null && zone.isNotEmpty && l.zone != zone) continue;
      if (rack != null && rack.isNotEmpty && l.rack != rack) continue;
      if (shelf != null && shelf.isNotEmpty && l.shelf != shelf) continue;
      final v = switch (field) {
        'zone' => l.zone,
        'rack' => l.rack,
        'shelf' => l.shelf,
        'slot' => l.slot,
        _ => '',
      };
      if (v.isNotEmpty) set.add(v);
    }
    final list = set.toList()..sort((a, b) => a.compareTo(b));
    return list;
  }

  List<String> zones(String? wh) => _values('zone', wh: wh);
  List<String> racks(String? wh, String? zone) => _values('rack', wh: wh, zone: zone);
  List<String> shelves(String? wh, String? zone, String? rack) =>
      _values('shelf', wh: wh, zone: zone, rack: rack);
  List<String> slots(String? wh, String? zone, String? rack, String? shelf) =>
      _values('slot', wh: wh, zone: zone, rack: rack, shelf: shelf);

  /// Resolves a scanned rack-label barcode against the Location Master.
  /// Mirrors legacy.html's resolveLocBarcode(): exact code match, then a
  /// match against any row's `rack` field, then a best-effort auto-parse of
  /// a compact "A-R03-2-05"-style code (zone-rack-shelf-slot).
  Location? resolveBarcode(String raw, {String? wh}) {
    final code = raw.trim().toUpperCase();
    if (code.isEmpty) return null;
    final exact = locations[code];
    if (exact != null) return exact;
    for (final l in locations.values) {
      if (l.rack.toUpperCase() == code) return l;
    }
    final parts = code.split('-').where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return null;
    String zone = '', rack = '', shelf = '', slot = '';
    final alphaOnly = RegExp(r'^[A-Z]$');
    final alnumWithLetter = RegExp(r'^[A-Z0-9]+$');
    final hasLetter = RegExp(r'[A-Z]');
    final digitsOnly = RegExp(r'^\d+$');
    for (final p in parts) {
      if (zone.isEmpty && alphaOnly.hasMatch(p)) {
        zone = p;
      } else if (rack.isEmpty && alnumWithLetter.hasMatch(p) && hasLetter.hasMatch(p)) {
        rack = p;
      } else if (shelf.isEmpty && digitsOnly.hasMatch(p)) {
        shelf = p;
      } else if (slot.isEmpty && digitsOnly.hasMatch(p)) {
        slot = p;
      } else if (rack.isEmpty) {
        rack = p;
      }
    }
    if (zone.isEmpty && rack.isEmpty && shelf.isEmpty && slot.isEmpty) return null;
    return Location(code: code, wh: wh ?? '', zone: zone, rack: rack, shelf: shelf, slot: slot);
  }
}
