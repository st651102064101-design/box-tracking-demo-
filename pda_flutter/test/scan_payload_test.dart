import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/scan_payload.dart';

void main() {
  test('strips AIM prefix and control characters from a DataWedge label', () {
    expect(normalizeScanPayload(']C1CRT-01\r\n'), 'CRT-01');
    expect(normalizeScanPayload(']d2BOX-010'), 'BOX-010');
    expect(normalizeScanPayload('  CRT-01  '), 'CRT-01');
    expect(normalizeScanPayload('CRT-01'), 'CRT-01');
  });
}
