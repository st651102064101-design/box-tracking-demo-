import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/radar_calibration.dart';
import 'package:smarttrace_pda/services/radar_distance.dart';

void main() {
  final start = DateTime(2026);
  test('one-metre window uses median, excludes other tags and invalid RSSI',
      () {
    final capture = RadarCalibration('EPC-A', start);
    for (var i = 0; i < 30; i++) {
      final at = start.add(Duration(milliseconds: i * 100));
      capture.add('epc-a', i == 0 ? -100 : -70, at);
      capture.add('OTHER', -30, at);
      capture.add('EPC-A', 0, at);
    }
    final reference = capture.finish(start.add(const Duration(seconds: 3)));
    expect(reference, -70);
    expect(RadarDistance.estimate(-70, referenceRssi: reference!), 1);
    expect(
        RadarDistance.estimate(-80, referenceRssi: reference), greaterThan(1));
  });
  test('sparse, early, expired and unstable readings cannot calibrate', () {
    final sparse = RadarCalibration('A', start)..add('A', -60, start);
    expect(sparse.finish(start.add(const Duration(seconds: 3))), isNull);
    final unstable = RadarCalibration('A', start);
    for (var i = 0; i < 30; i++)
      unstable.add('A', i.isEven ? -90 : -40,
          start.add(Duration(milliseconds: i * 100)));
    expect(unstable.finish(start.add(const Duration(seconds: 3))), isNull);
    final expired = RadarCalibration('A', start);
    for (var i = 0; i < 30; i++)
      expired.add('A', -60, start.add(const Duration(seconds: 5)));
    expect(expired.finish(start.add(const Duration(seconds: 5))), isNull);
    final duplicated = RadarCalibration('A', start);
    for (var i = 0; i < 1000; i++) duplicated.add('A', -60, start);
    expect(duplicated.finish(start.add(const Duration(seconds: 3))), isNull);
  });
}
