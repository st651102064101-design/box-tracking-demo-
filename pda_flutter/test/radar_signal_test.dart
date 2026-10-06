import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/radar_signal.dart';

void main() {
  test('pulse cadence changes smoothly across the full slow to fast range', () {
    final clock = RadarPulseClock();
    final start = DateTime(2026);
    var slowPulses = 0;
    for (var ms = 0; ms <= 1400; ms += 20) {
      if (clock.advance(start.add(Duration(milliseconds: ms)),
          const Duration(milliseconds: 700))) slowPulses++;
    }
    expect(slowPulses, 2);
    var fastPulses = 0;
    for (var ms = 1420; ms <= 2420; ms += 20) {
      if (clock.advance(start.add(Duration(milliseconds: ms)),
          const Duration(milliseconds: 100))) fastPulses++;
    }
    expect(fastPulses, 10);
    final transition = RadarPulseClock();
    transition.advance(start, const Duration(milliseconds: 700));
    var count = 0;
    for (var ms = 20; ms <= 1400; ms += 20) {
      final interval = ms < 700
          ? 700 - (ms * .6).round()
          : 280 - ((ms - 700) * .257).round();
      if (transition.advance(start.add(Duration(milliseconds: ms)),
          Duration(milliseconds: interval))) count++;
    }
    expect(count, inInclusiveRange(3, 8));
  });
  test('spikes and high-rate reads cannot jump RSSI or tick cadence', () {
    final filter = RadarSmoother();
    final start = DateTime(2026);
    expect(filter.update(-80, start), -80);
    for (var i = 1; i <= 100; i++) {
      final value = filter.update(-40, start.add(Duration(milliseconds: i)));
      expect(value, lessThanOrEqualTo(-79));
      expect(RadarSignal.gap(RadarSignal.level(value)).inMilliseconds,
          greaterThan(490));
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
      expect(RadarSignal.level(samples[i]),
          greaterThanOrEqualTo(RadarSignal.level(samples[i - 1])));
      expect(
          RadarSignal.gap(RadarSignal.level(samples[i])).inMilliseconds,
          lessThanOrEqualTo(RadarSignal.gap(RadarSignal.level(samples[i - 1]))
              .inMilliseconds));
    }
    expect(RadarSignal.sound(RadarSignal.level(-45)), 'grade_found');
    expect(RadarSignal.gap(1).inMilliseconds, 60);
  });

  test('cadence interval has no discrete grade plateaus', () {
    final gaps = <int>[];
    for (var level = 0.0; level <= 1.0001; level += 0.01) {
      gaps.add(RadarSignal.gap(level).inMilliseconds);
    }
    expect(gaps.first, 1200);
    expect(gaps.last, 60);
    expect(gaps, orderedEquals(gaps.toList()..sort((a, b) => b.compareTo(a))));
    expect(gaps.toSet().length, greaterThanOrEqualTo(100));
  });
}
