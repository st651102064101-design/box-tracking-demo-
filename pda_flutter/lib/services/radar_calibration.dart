import 'radar_distance.dart';

/// A short stable sample window at the operator's confirmed one-metre position.
class RadarCalibration {
  final String epc;
  final DateTime startedAt;
  final _samples = <int>[];
  DateTime? _firstAt;
  DateTime? _lastAt;
  RadarCalibration(this.epc, this.startedAt);
  void add(String observedEpc, int? rssi, DateTime at) {
    if (observedEpc.toUpperCase() != epc.toUpperCase() ||
        !RadarDistance.validRssi(rssi) ||
        at.isBefore(startedAt) ||
        at.difference(startedAt) > const Duration(seconds: 4)) return;
    if (_lastAt != null &&
        at.difference(_lastAt!) < const Duration(milliseconds: 50)) return;
    if (_samples.length < 256) {
      _firstAt ??= at;
      _lastAt = at;
      _samples.add(rssi!);
    }
  }

  int? finish(DateTime at) {
    if (_samples.length < 8 ||
        at.difference(startedAt) < const Duration(seconds: 2) ||
        _lastAt!.difference(_firstAt!) < const Duration(seconds: 1))
      return null;
    final sorted = _samples.toList()..sort();
    if (sorted[(sorted.length * .9).floor()] -
            sorted[(sorted.length * .1).floor()] >
        12) return null;
    return sorted[sorted.length ~/ 2];
  }
}
