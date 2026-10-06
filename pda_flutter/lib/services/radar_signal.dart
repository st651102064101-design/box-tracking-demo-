import 'dart:math' as math;

/// Time-based filtering: read rate cannot speed up the displayed approach.
class RadarSmoother {
  double? _value;
  DateTime? _at;

  int update(int rssi, DateTime now) {
    if (_value == null ||
        _at == null ||
        now.difference(_at!) > RadarSignal.staleAfter) {
      _value = rssi.toDouble();
    } else {
      final seconds = now.difference(_at!).inMicroseconds / 1000000;
      if (seconds > 0) {
        final dt = math.min(seconds, .25);
        final step = (rssi - _value!) * (1 - math.exp(-dt / .65));
        _value = _value! + step.clamp(-8 * dt, 8 * dt);
      }
    }
    _at = now;
    return _value!.round();
  }
}

/// Time accumulator keeps the mean beep rate continuous despite 20 ms frames.
class RadarPulseClock {
  double _phase = 0;
  DateTime? _lastAt;

  bool advance(DateTime now, Duration interval) {
    final previous = _lastAt;
    _lastAt = now;
    if (previous == null) return false;
    final elapsed = now.difference(previous).inMicroseconds / 1000;
    if (elapsed <= 0) return false;
    _phase += elapsed / interval.inMilliseconds;
    if (_phase < 1) return false;
    _phase -= _phase.floorToDouble();
    return true;
  }

  void reset() {
    _phase = 0;
    _lastAt = null;
  }
}

/// Relative RSSI feedback, not a distance estimate in metres.
class RadarSignal {
  static const staleAfter = Duration(milliseconds: 1500);
  static double level(int rssi) => ((rssi + 95) / 50).clamp(0.04, 1.0);
  static Duration gap(double level) =>
      Duration(milliseconds: (1200 - level.clamp(0.0, 1.0) * 1140).round());
  static String sound(double level) => level > .75
      ? 'grade_found'
      : level > .55
          ? 'grade_close'
          : level > .25
              ? 'grade_warm'
              : 'grade_far';
}
