/// What barcode / RFID stack this handheld can actually use.
///
/// Resolved from Android [Build] fields (via the native `deviceInfo` channel),
/// not from a guess. Shared by device setup UI and [AppController] so the
/// capability shown at provisioning matches the runtime scan path.
class HandheldCapability {
  final String id;
  final String displayName;
  final String androidVersionLabel;
  final String note;

  /// Zebra DataWedge (or equivalent wedge) is available for hardware barcode.
  final bool usesZebraSdk;

  /// Integrated UHF reader (MC3390R family).
  final bool hasIntegratedRfid;

  /// No supported barcode/RFID SDK for this model — operator must use camera.
  bool get needsCameraBarcode => !usesZebraSdk;

  final String barcodeMethod;

  const HandheldCapability({
    required this.id,
    required this.displayName,
    required this.androidVersionLabel,
    required this.note,
    required this.usesZebraSdk,
    required this.hasIntegratedRfid,
    required this.barcodeMethod,
  });

  /// [info] is the map from native `deviceInfo` (`manufacturer`, `model`,
  /// `brand`, `androidRelease`). Missing keys are treated as empty.
  factory HandheldCapability.fromDeviceInfo(Map<String, dynamic> info) {
    final model = (info['model'] ?? '').toString().trim();
    final manufacturer = (info['manufacturer'] ?? '').toString().trim();
    final brand = (info['brand'] ?? '').toString().trim();
    final release = (info['androidRelease'] ?? '').toString().trim();
    final modelUpper = model.toUpperCase();
    final isMc3390r = modelUpper.contains('MC3390');
    final isTc52 = modelUpper.contains('TC52');
    final isZebra = manufacturer.toUpperCase().contains('ZEBRA') ||
        brand.toUpperCase().contains('ZEBRA');
    final androidLabel = release.isEmpty ? '' : 'Android $release';

    if (isMc3390r) {
      return const HandheldCapability(
        id: 'mc3390r',
        displayName: 'Zebra MC3300 Series (MC3390R)',
        androidVersionLabel: 'Android 8.0 (Oreo)',
        note: 'เครื่องอ่าน RFID ในตัวเครื่อง',
        usesZebraSdk: true,
        hasIntegratedRfid: true,
        barcodeMethod: 'Zebra DataWedge SDK + เครื่องอ่าน UHF RFID',
      );
    }
    if (isTc52) {
      return HandheldCapability(
        id: 'tc52',
        displayName: 'Zebra TC52',
        androidVersionLabel: androidLabel,
        note: 'สแกนบาร์โค้ดในตัวเครื่อง · ไม่มี UHF RFID ในตัว',
        usesZebraSdk: true,
        hasIntegratedRfid: false,
        barcodeMethod: 'Zebra DataWedge SDK สำหรับปุ่มสแกนบาร์โค้ด',
      );
    }
    if (isZebra) {
      return HandheldCapability(
        id: 'zebra',
        displayName: ['Zebra', model].where((s) => s.isNotEmpty).join(' '),
        androidVersionLabel: androidLabel,
        note: 'ไม่พบ UHF RFID ในตัวเครื่อง',
        usesZebraSdk: true,
        hasIntegratedRfid: false,
        barcodeMethod: 'Zebra DataWedge SDK สำหรับปุ่มสแกนบาร์โค้ด',
      );
    }

    final nameParts = [manufacturer, model].where((s) => s.isNotEmpty).join(' ');
    return HandheldCapability(
      id: 'generic',
      displayName: nameParts.isEmpty ? 'อุปกรณ์นี้' : nameParts,
      androidVersionLabel: androidLabel,
      note:
          'SDK บาร์โค้ด/RFID ของ Zebra ไม่รองรับรุ่นนี้ — สแกนผ่านกล้องของเครื่อง',
      usesZebraSdk: false,
      hasIntegratedRfid: false,
      barcodeMethod: 'สแกนบาร์โค้ด/QR ผ่านกล้องในแอป',
    );
  }
}
