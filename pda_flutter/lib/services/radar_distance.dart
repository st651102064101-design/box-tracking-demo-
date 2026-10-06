import 'dart:math' as math;

/// RSSI-based approximation anchored to this tag at one metre, at the same
/// transmit power. Backscatter falls on both outbound and return paths; the
/// fourth-power model is a heuristic, not a ranging measurement. Tag angle,
/// shelving and multipath can still change the result substantially.
class RadarDistance {
  /// Generic backscatter heuristic, NOT a measured device/tag calibration.
  /// Radar operates at maximum transmit power. Orientation and shelving can
  /// shift this estimate considerably; never use it as an exact range.
  static double? estimate(int? rssi, {int referenceRssi = -60}) {
    final distance = metres(rssi, referenceRssi);
    return distance?.clamp(.1, 30).toDouble();
  }

  static bool validRssi(int? rssi) => rssi != null && rssi >= -120 && rssi < 0;

  static double? metres(int? rssi, int? referenceAtOneMetre) {
    if (!validRssi(rssi) || !validRssi(referenceAtOneMetre)) return null;
    return math.pow(10, (referenceAtOneMetre! - rssi!) / 40).toDouble();
  }

  /// Ten-centimetre resolution avoids implying centimetre-level accuracy.
  static String label(double? metres, {bool english = false}) {
    if (metres == null || !metres.isFinite || metres <= 0) return '—';
    final centimetres = math.max(10, (metres * 10).round() * 10);
    final m = centimetres ~/ 100;
    final cm = centimetres % 100;
    final mUnit = english ? 'm' : 'ม.';
    final cmUnit = english ? 'cm' : 'ซม.';
    if (m == 0) return '≈ $cm $cmUnit';
    if (cm == 0) return '≈ $m $mUnit';
    return '≈ $m $mUnit $cm $cmUnit';
  }
}
