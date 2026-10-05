import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/radar_signal.dart';
void main() {
  test('detected weak signal remains visible and gets an audible far tick', () {
    expect(RadarSignal.level(-110), greaterThan(0));
    expect(RadarSignal.sound(RadarSignal.level(-110)), 'grade_far');
  });
  test('stronger signal increases level and tick cadence monotonically', () {
    final samples = [-100, -90, -80, -70, -60, -45];
    for (var i = 1; i < samples.length; i++) {
      expect(RadarSignal.level(samples[i]), greaterThanOrEqualTo(RadarSignal.level(samples[i-1])));
      expect(RadarSignal.gap(RadarSignal.level(samples[i])).inMilliseconds, lessThanOrEqualTo(RadarSignal.gap(RadarSignal.level(samples[i-1])).inMilliseconds));
    }
    expect(RadarSignal.sound(RadarSignal.level(-45)), 'grade_found');
    expect(RadarSignal.gap(1).inMilliseconds, 100);
  });
}
