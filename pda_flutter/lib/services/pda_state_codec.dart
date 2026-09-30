import 'dart:convert';

/// Convert either the legacy full-state payload or the compact PDA payload
/// into the data the handheld actually renders. Kept top-level so Flutter can
/// run it on a worker isolate for both network responses and old disk caches.
Map<String, dynamic> decodePdaState(String body) {
  final source = jsonDecode(body) as Map<String, dynamic>;
  final cutoff = DateTime.now().toUtc().subtract(const Duration(days: 2));
  final boxes = source['boxes'];
  if (boxes is Map) {
    // The tracking page renders the latest six movements only. Trim legacy
    // caches and older backend responses here as well, before the parsed state
    // is copied from this worker isolate to the UI isolate.
    for (final value in boxes.values) {
      if (value is! Map) continue;
      final history = value['history'];
      if (history is List && history.length > 6) {
        value['history'] = history.sublist(history.length - 6);
      }
    }
  }
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
