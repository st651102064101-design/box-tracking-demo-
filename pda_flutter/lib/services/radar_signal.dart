/// Relative RSSI feedback, not a distance estimate in metres.
class RadarSignal {
  static const staleAfter = Duration(milliseconds: 1500);
  static double level(int rssi) => ((rssi + 95) / 50).clamp(0.04, 1.0);
  static Duration gap(double level) => Duration(milliseconds: (700 - level.clamp(0.0, 1.0) * 600).round());
  static String sound(double level) => level > .75 ? 'grade_found' : level > .55 ? 'grade_close' : level > .25 ? 'grade_warm' : 'grade_far';
}
