import 'rfid_service.dart';

/// The status line of the scan panel. [label] is an untranslated i18n key.
typedef ScannerStatus = ({bool ready, String label});

/// Only RFID scanning depends on the RFID reader: the barcode imager of a
/// barcode scan (or of a terminal without RFID) needs no connection.
ScannerStatus scannerStatus({
  required bool supported,
  required bool usesRfid,
  required RfidState state,
  required bool reading,
}) {
  if (!supported) return (ready: true, label: 'โหมดจำลอง');
  if (!usesRfid) return (ready: true, label: 'สแกนเนอร์พร้อม');
  if (reading) return (ready: true, label: 'กำลังอ่านแท็ก RFID…');
  return switch (state) {
    RfidState.connected => (ready: true, label: 'สแกนเนอร์พร้อม'),
    RfidState.connecting => (ready: false, label: 'กำลังเชื่อมต่อ…'),
    _ => (ready: false, label: 'สแกนเนอร์ไม่พร้อม'),
  };
}
