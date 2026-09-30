import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:smarttrace_pda/services/api_client.dart';
import 'package:smarttrace_pda/services/prefs.dart';

void main() {
  test('handheld state decode trims old history and unused web data', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final recent = DateTime.now().toUtc().toIso8601String();
    final old = DateTime.now()
        .toUtc()
        .subtract(const Duration(days: 3))
        .toIso8601String();
    final requests = <String>[];
    final serving = server.listen((request) {
      requests.add(request.uri.toString());
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({
        'boxes': {'BOX-1': {'status': 'warehouse'}},
        'events': [
          {'ts': old, 'dir': 'in'},
          {'ts': recent, 'dir': 'out'},
        ],
        'auditLog': List.generate(1000, (i) => {'id': i}),
      }));
      request.response.close();
    });
    try {
      final api = ApiClient(baseUrl: 'http://127.0.0.1:${server.port}');
      final state = await api.getState();
      expect(requests, ['/api/state/pda']);
      expect(state['boxes'], contains('BOX-1'));
      expect(state['events'], [containsPair('ts', recent)]);
      expect(state, isNot(contains('auditLog')));
    } finally {
      await serving.cancel();
      await server.close(force: true);
    }
  });

  test('legacy offline cache is trimmed when restored', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    prefs.stateCache = {
      'boxes': {'BOX-1': {'status': 'warehouse'}},
      'events': [
        {'ts': DateTime.now().toUtc().subtract(const Duration(days: 5)).toIso8601String()},
      ],
      'auditLog': List.generate(40000, (i) => {'id': i, 'note': 'x' * 20}),
    };
    final restored = await prefs.loadStateCache();
    expect(restored?['boxes'], contains('BOX-1'));
    expect(restored?['events'], isEmpty);
    expect(restored, isNot(contains('auditLog')));
    expect(prefs.stateCache, isNot(contains('auditLog')),
        reason: 'a legacy full snapshot should be migrated on disk too');
  });
}
