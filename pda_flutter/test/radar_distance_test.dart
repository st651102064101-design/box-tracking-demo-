import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/radar_distance.dart';

void main() {
  test('no metric distance without calibration or a valid RSSI reading', () {
    expect(RadarDistance.metres(-60, null), isNull);
    for (final invalid in <int?>[null, 0, 10, -121]) {
      expect(RadarDistance.metres(invalid, -60), isNull);
      expect(RadarDistance.metres(-60, invalid), isNull);
    }
    expect(RadarDistance.label(null), '—');
  });

  test('reference reading is 1 metre; weaker readings estimate further away',
      () {
    expect(RadarDistance.metres(-60, -60), 1);
    expect(RadarDistance.metres(-80, -60), closeTo(3.1623, .0001));
    expect(RadarDistance.metres(-40, -60), closeTo(.3162, .0001));
    expect(RadarDistance.metres(-60, -70),
        lessThan(RadarDistance.metres(-60, -50)!));
  });

  test('metric readout rounds to 10 cm and carries into metres in TH and EN',
      () {
    expect(RadarDistance.label(.3162), '≈ 30 ซม.');
    expect(RadarDistance.label(1), '≈ 1 ม.');
    expect(RadarDistance.label(1.24), '≈ 1 ม. 20 ซม.');
    expect(RadarDistance.label(.96), '≈ 1 ม.');
    expect(RadarDistance.label(.01), '≈ 10 ซม.');
    expect(RadarDistance.label(1.24, english: true), '≈ 1 m 20 cm');
    expect(RadarDistance.label(double.nan), '—');
    expect(RadarDistance.label(double.infinity), '—');
  });
}
