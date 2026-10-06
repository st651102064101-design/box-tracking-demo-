import 'api_client.dart';
import 'rfid_service.dart';
import 'radar_distance.dart';

/// Bounded metadata queue; gate scans never await network/TID.
class RadarTelemetry {
  final ApiClient api;
  final RfidService rfid;
  final String Function() model;
  final int Function() power;
  RadarTelemetry(
      {required this.api,
      required this.rfid,
      required this.model,
      required this.power});
  final _pending = <String, Map<String, dynamic>>{};
  final _identified = <String, String>{};
  bool _flushing = false;
  int _cursor = 0;
  void observe(String tag, RfidTagRead read, {String readerProfile = 'fast'}) {
    final epc = read.epc.trim().toUpperCase();
    if (epc.isEmpty || model().isEmpty) return;
    final key = '$epc|${model()}|${power()}|$readerProfile';
    if (!_pending.containsKey(key) && _pending.length >= 256) return;
    final old = _pending[key];
    _pending[key] = {
      ...?old,
      'tag': tag,
      'epc': epc,
      'model': model(),
      'powerPercent': power(),
      'readerProfile': readerProfile,
      if ((read.tid ?? _identified[epc]) != null)
        'tid': read.tid ?? _identified[epc],
      if (RadarDistance.validRssi(read.rssi))
        'weakestRssi':
            old?['weakestRssi'] is int && old!['weakestRssi'] < read.rssi!
                ? old['weakestRssi']
                : read.rssi
    };
  }

  Future<void> flush({bool allowTid = false}) async {
    if (_flushing || _pending.isEmpty) return;
    _flushing = true;
    final batch = _pending.entries.take(64).toList();
    for (final entry in batch) _pending.remove(entry.key);
    var succeeded = false;
    try {
      if (allowTid) {
        final unknown = batch.where((e) => e.value['tid'] == null).toList();
        if (unknown.isNotEmpty) {
          final item = unknown[_cursor++ % unknown.length].value;
          final tid = await rfid.readTid(item['epc'] as String);
          if (tid != null && RegExp(r'^[0-9a-fA-F]{8,128}$').hasMatch(tid)) {
            item['tid'] = tid.toUpperCase();
            if (_identified.length >= 256)
              _identified.remove(_identified.keys.first);
            _identified[item['epc'] as String] = tid.toUpperCase();
          }
        }
      }
      await api.observeRadar(batch.map((e) => e.value).toList());
      succeeded = true;
    } catch (_) {
      for (final entry in batch) {
        final newer = _pending[entry.key];
        if (newer != null) {
          final olderWeakest = entry.value['weakestRssi'];
          final newerWeakest = newer['weakestRssi'];
          if (olderWeakest is int &&
              (newerWeakest is! int || olderWeakest < newerWeakest)) {
            newer['weakestRssi'] = olderWeakest;
          }
          if (newer['tid'] == null && entry.value['tid'] != null) {
            newer['tid'] = entry.value['tid'];
          }
        } else if (_pending.length < 256) {
          _pending[entry.key] = entry.value;
        }
      }
    } finally {
      _flushing = false;
    }
    if (succeeded && _pending.isNotEmpty) await flush();
  }
}
