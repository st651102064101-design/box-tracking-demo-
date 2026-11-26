import 'package:flutter_test/flutter_test.dart';

import 'package:smarttrace_pda/services/rfid_service.dart';
import 'package:smarttrace_pda/services/scanner_status.dart';

void main() {
  ScannerStatus status({
    bool supported = true,
    bool usesRfid = true,
    RfidState state = RfidState.disconnected,
    bool reading = false,
  }) =>
      scannerStatus(
          supported: supported,
          usesRfid: usesRfid,
          state: state,
          reading: reading);

  test('barcode scanning is ready whatever the RFID radio is doing', () {
    // A TC52 has no RFID radio, so it never reports "connected".
    for (final state in RfidState.values) {
      final s = status(usesRfid: false, state: state, reading: true);
      expect((s.ready, s.label), (true, 'สแกนเนอร์พร้อม'), reason: '$state');
    }
  });

  test('RFID scanning still follows the reader', () {
    expect(status().ready, isFalse);
    expect(status().label, 'สแกนเนอร์ไม่พร้อม');
    expect(status(state: RfidState.connecting).label, 'กำลังเชื่อมต่อ…');
    expect(status(state: RfidState.connected).ready, isTrue);
    expect(status(state: RfidState.connected, reading: true).label,
        'กำลังอ่านแท็ก RFID…');
  });

  test('without reader hardware it says it is simulating', () {
    final s = status(supported: false, usesRfid: false);
    expect((s.ready, s.label), (true, 'โหมดจำลอง'));
  });
}
