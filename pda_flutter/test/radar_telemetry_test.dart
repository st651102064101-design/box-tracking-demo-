import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/radar_telemetry.dart';
import 'package:smarttrace_pda/services/api_client.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';

class _Api extends ApiClient {
  _Api() : super(baseUrl: 'http://fake');
  final calls = <List<Map<String, dynamic>>>[];
  bool fail = false;
  Completer<void>? hold;
  @override
  Future<void> observeRadar(List<Map<String, dynamic>> rows) async {
    calls.add(rows);
    if (hold != null) await hold!.future;
    if (fail) throw Exception('offline');
  }
}

class _Reader extends RfidService {
  int reads = 0;
  @override
  Future<String?> readTid(String epc) async {
    reads++;
    return 'E2801190';
  }
}

void main() {
  test(
      '1000 repeated gate observations batch to one API row and one optional TID read',
      () async {
    final api = _Api();
    final reader = _Reader();
    final queue = RadarTelemetry(
        api: api, rfid: reader, model: () => 'mc3390r', power: () => 100);
    for (var i = 0; i < 1000; i++)
      queue.observe(
          'BOX-001',
          RfidTagRead(
              epc: 'ABCD1234',
              rssi: i.isEven ? -60 : -80,
              readAt: DateTime.now()));
    expect(api.calls, isEmpty);
    expect(reader.reads, 0);
    await Future.wait(
        [queue.flush(allowTid: true), queue.flush(allowTid: true)]);
    expect(api.calls, hasLength(1));
    expect(api.calls.single, hasLength(1));
    expect(api.calls.single.single['weakestRssi'], -80);
    expect(reader.reads, 1);
    queue.observe('BOX-001',
        RfidTagRead(epc: 'ABCD1234', rssi: -70, readAt: DateTime.now()));
    await queue.flush(allowTid: true);
    expect(reader.reads, 1);
  });
  test(
      'metadata failure retries without blocking gate input, no TID in barcode mode',
      () async {
    final api = _Api()..fail = true;
    final reader = _Reader();
    final queue = RadarTelemetry(
        api: api, rfid: reader, model: () => 'mc3390r', power: () => 100);
    queue.observe('BOX-001',
        RfidTagRead(epc: 'ABCD1234', rssi: -80, readAt: DateTime.now()));
    await queue.flush();
    expect(reader.reads, 0);
    api.fail = false;
    await queue.flush();
    expect(api.calls, hasLength(2));
    await queue.flush();
    expect(api.calls, hasLength(2));
  });
  test('dense scans bound memory and send batches of at most 64', () async {
    final api = _Api();
    final reader = _Reader();
    final queue = RadarTelemetry(
        api: api, rfid: reader, model: () => 'mc3390r', power: () => 100);
    for (var i = 0; i < 1000; i++)
      queue.observe('BOX-$i',
          RfidTagRead(epc: 'EPC-$i', rssi: -70, readAt: DateTime.now()));
    await queue.flush();
    expect(api.calls, hasLength(4));
    expect(api.calls.every((c) => c.length == 64), isTrue);
  });
  test('failed in-flight batch merges weakest signal with newer observation', () async {
    final api = _Api()..fail = true..hold = Completer<void>();
    final queue = RadarTelemetry(api: api, rfid: _Reader(),
        model: () => 'mc3390r', power: () => 100);
    queue.observe('BOX-001', RfidTagRead(epc: 'ABCD1234', rssi: -90, readAt: DateTime.now()));
    final flushing = queue.flush();
    queue.observe('BOX-001', RfidTagRead(epc: 'ABCD1234', rssi: -60, readAt: DateTime.now()));
    api.hold!.complete();
    await flushing;
    api.fail = false;
    await queue.flush();
    expect(api.calls.last.single['weakestRssi'], -90);
  });
}
