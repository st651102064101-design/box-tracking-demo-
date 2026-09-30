import 'dart:convert';

/// Convert either the legacy full-state payload or the compact PDA payload
/// into the data the handheld actually renders. Kept top-level so Flutter can
/// run it on a worker isolate for both network responses and old disk caches.
Map<String, dynamic> decodePdaState(String body) {
  final source = jsonDecode(body) as Map<String, dynamic>;
  final cutoff = DateTime.now().toUtc().subtract(const Duration(days: 2));
  final events = source['events'];
  return {
    for (final key in [
      'boxes', 'customers', 'boxtypes', 'warehouses', 'gates',
      'employees', 'cfg', 'locations',
    ])
      if (source.containsKey(key)) key: source[key],
    'events': events is List
        ? events.where((event) {
            if (event is! Map) return false;
            final ts = DateTime.tryParse(event['ts']?.toString() ?? '');
            return ts != null && !ts.toUtc().isBefore(cutoff);
          }).toList()
        : <dynamic>[],
  };
}
