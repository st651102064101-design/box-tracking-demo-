import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/handheld_capability.dart';

void main() {
  group('HandheldCapability.fromDeviceInfo', () {
    test('MC3390R gets Zebra SDK + integrated RFID', () {
      final c = HandheldCapability.fromDeviceInfo({
        'manufacturer': 'Zebra Technologies',
        'brand': 'Zebra',
        'model': 'MC3390R',
        'androidRelease': '8.1.0',
      });
      expect(c.id, 'mc3390r');
      expect(c.usesZebraSdk, isTrue);
      expect(c.hasIntegratedRfid, isTrue);
      expect(c.needsCameraBarcode, isFalse);
    });

    test('TC52 gets DataWedge barcode but no RFID and no camera fallback', () {
      final c = HandheldCapability.fromDeviceInfo({
        'manufacturer': 'Zebra Technologies',
        'brand': 'Zebra',
        'model': 'TC52',
        'androidRelease': '10',
      });
      expect(c.id, 'tc52');
      expect(c.usesZebraSdk, isTrue);
      expect(c.hasIntegratedRfid, isFalse);
      expect(c.needsCameraBarcode, isFalse);
      expect(c.androidVersionLabel, 'Android 10');
    });

    test('other Zebra model keeps DataWedge without assuming RFID', () {
      final c = HandheldCapability.fromDeviceInfo({
        'manufacturer': 'Zebra Technologies',
        'brand': 'Zebra',
        'model': 'TC21',
        'androidRelease': '11',
      });
      expect(c.id, 'zebra');
      expect(c.usesZebraSdk, isTrue);
      expect(c.hasIntegratedRfid, isFalse);
      expect(c.needsCameraBarcode, isFalse);
    });

    test('non-Zebra phone requires camera barcode when SDK unsupported', () {
      final c = HandheldCapability.fromDeviceInfo({
        'manufacturer': 'Samsung',
        'brand': 'samsung',
        'model': 'SM-A546B',
        'androidRelease': '14',
      });
      expect(c.id, 'generic');
      expect(c.usesZebraSdk, isFalse);
      expect(c.hasIntegratedRfid, isFalse);
      expect(c.needsCameraBarcode, isTrue);
      expect(c.barcodeMethod, contains('กล้อง'));
      expect(c.displayName, contains('Samsung'));
    });

    test('empty deviceInfo falls back to camera path', () {
      final c = HandheldCapability.fromDeviceInfo(const {});
      expect(c.id, 'generic');
      expect(c.needsCameraBarcode, isTrue);
      expect(c.hasIntegratedRfid, isFalse);
    });

    test('TC52 is not classified as MC3390R just because it is Zebra', () {
      final c = HandheldCapability.fromDeviceInfo({
        'manufacturer': 'Zebra Technologies',
        'brand': 'Zebra',
        'model': 'TC52ax',
      });
      expect(c.id, 'tc52');
      expect(c.hasIntegratedRfid, isFalse);
    });
  });
}
