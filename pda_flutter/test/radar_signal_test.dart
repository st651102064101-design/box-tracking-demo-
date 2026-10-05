import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/radar_signal.dart';
void main() {
  test('spikes and high-rate reads cannot jump RSSI or tick cadence', () {
    final filter = RadarSmoother();
    final start = DateTime(2026);
    expect(filter.update(-80, start), -80);
    for (var i = 1; i <= 100; i++) {
      final value = filter.update(-40, start.add(Duration(milliseconds: i)));
      expect(value, lessThanOrEqualTo(-79));
      expect(RadarSignal.gap(RadarSignal.level(value)).inMilliseconds, greaterThan(490));
    }
    expect(filter.update(-40, start.add(const Duration(seconds: 3))), -40);
  });
  test('sustained approach changes gradually and targets stay independent', () {
    final a = RadarSmoother();
    final b = RadarSmoother();
    final start = DateTime(2026);
    var previous = a.update(-80, start);
    b.update(-95, start);
    for (var i = 1; i <= 20; i++) {
      final value = a.update(-50, start.add(Duration(milliseconds: i * 100)));
      expect(value, greaterThanOrEqualTo(previous));
      expect(value - previous, lessThanOrEqualTo(1));
      previous = value;
    }
    expect(previous, greaterThan(-80));
    expect(b.update(-95, start.add(const Duration(seconds: 1))), -95);
  });
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
