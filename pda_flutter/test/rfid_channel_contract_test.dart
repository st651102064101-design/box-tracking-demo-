import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/rfid_service.dart';

const methods = MethodChannel('smarttrace/rfid');
const events = 'smarttrace/rfid/events';
const codec = StandardMethodCodec();

class AndroidRfidService extends RfidService {
  @override
  bool get supported => true;
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  late RfidService service;
  late List<MethodCall> calls;
  Future<void> send(Map<String, Object?> event) async {
    await binding.defaultBinaryMessenger.handlePlatformMessage(
      events, codec.encodeSuccessEnvelope(event), (_) {},
    );
  }
  setUp(() {
    calls = [];
    binding.defaultBinaryMessenger.setMockMethodCallHandler(methods, (call) async {
      calls.add(call);
      return null;
    });
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel(events), (call) async { calls.add(call); return null; },
    );
    service = AndroidRfidService()..ensureListening();
  });
  tearDown(() {
    service.dispose();
    binding.defaultBinaryMessenger.setMockMethodCallHandler(methods, null);
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel(events), null);
  });

  testWidgets('SDK batch preserves EPC, TID and metadata and flushes once per frame', (tester) async {
    final batches = <List<RfidTagRead>>[];
    final tags = <String>[];
    service.tagBatches.listen(batches.add);
    service.tags.listen(tags.add);
    await send({'type': 'tags', 'tags': [
      {'epc': 'e200abcd', 'tid': 'E280ABCD', 'rssi': -44, 'antenna': 1},
      {'epc': 'E200FFFF'}, {'epc': 'E200FFFF'},
    ]});
    expect(batches, isEmpty);
    await tester.pump();
    expect(batches, hasLength(1));
    expect(tags, ['e200abcd', 'E200FFFF', 'E200FFFF']);
    expect(batches.single.first.tid, 'E280ABCD');
    expect(batches.single.first.rssi, -44);
  });
  testWidgets('malformed tag metadata and raw bytes do not poison valid tags in a batch', (tester) async {
    final tags = <String>[];
    service.tags.listen(tags.add);
    await send({'type': 'tags', 'tags': [
      {'epc': ''}, {'epc': '   '}, {'epc': [0xE2, 0]},
      {'epc': 'BAD', 'rssi': 'invalid'},
      {'epc': 'E200ABCD'},
    ]});
    await tester.pump();
    expect(tags, ['E200ABCD']);
    expect(tester.takeException(), isNull);
  });
  testWidgets('stopInventory invalidates buffered reads before rapid mode changes', (tester) async {
    final tags = <String>[];
    service.tags.listen(tags.add);
    await send({'type': 'tags', 'tags': [{'epc': 'OLD'}]});
    await service.stopInventory();
    await send({'type': 'tags', 'tags': [{'epc': 'NEW'}]});
    await tester.pump();
    expect(tags, ['NEW']);
    expect(calls.where((c) => c.method == 'stopInventory'), hasLength(1));
  });
  test('disconnect and reconnect status events remain ordered with one listener', () async {
    final states = <RfidState>[];
    service.status.listen((event) => states.add(event.state));
    service.ensureListening();
    await Future<void>.delayed(Duration.zero);
    await send({'type': 'status', 'state': 'connected'});
    await send({'type': 'status', 'state': 'disconnected'});
    await send({'type': 'status', 'state': 'connecting'});
    await send({'type': 'status', 'state': 'connected'});
    await Future<void>.delayed(Duration.zero);
    expect(states, [RfidState.connected, RfidState.disconnected, RfidState.connecting, RfidState.connected]);
    expect(calls.where((c) => c.method == 'listen'), hasLength(1));
  });
  testWidgets('SDK connect PlatformException becomes error status without throwing', (tester) async {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(methods, (call) async {
      throw PlatformException(code: 'RFID_COMM', message: 'reader unavailable');
    });
    final statuses = <RfidStatus>[];
    service.status.listen(statuses.add);
    await service.connect();
    await tester.pump();
    expect(service.state, RfidState.error);
    expect(statuses.last.message, 'reader unavailable');
  });
  testWidgets('dispose before pending flush releases stream without delivery or exception', (tester) async {
    final tags = <String>[];
    service.tags.listen(tags.add);
    await send({'type': 'tags', 'tags': [{'epc': 'OLD'}]});
    service.dispose();
    await tester.pump();
    expect(tags, isEmpty);
    expect(tester.takeException(), isNull);
    service = RfidService();
  });
  testWidgets('connect failure arriving after dispose does not write a closed stream', (tester) async {
    final pending = Completer<Object?>();
    binding.defaultBinaryMessenger.setMockMethodCallHandler(methods, (call) => pending.future);
    final connecting = service.connect();
    service.dispose();
    pending.completeError(PlatformException(code: 'RFID_COMM'));
    await connecting;
    await tester.pump();
    expect(tester.takeException(), isNull);
    service = RfidService();
  });
}
