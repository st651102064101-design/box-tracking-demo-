/// One classification of a handheld, shared by boot detection and device setup.
///
/// TC52 is barcode-only. MC3390R and TC501 have an integrated UHF reader.
/// Brand alone never turns RFID on.
class HandheldProfile {
  final String id;
  final String name;
  final String androidVersion;
  final String note;
  final bool hasIntegratedRfid;
  final bool usesZebraSdk;
  final String barcodeMethod;
  final String presenceName;

  /// Android reported a model string. An empty report must not overwrite a
  /// profile that was already saved on the terminal.
  final bool modelKnown;

  const HandheldProfile({
    required this.id,
    required this.name,
    required this.androidVersion,
    required this.note,
    required this.hasIntegratedRfid,
    required this.usesZebraSdk,
    required this.barcodeMethod,
    required this.presenceName,
    required this.modelKnown,
  });

  static HandheldProfile classify({
    required String model,
    required String manufacturer,
    required String brand,
    String androidRelease = '',
  }) {
    final modelUpper = model.trim().toUpperCase();
    final zebra = manufacturer.toUpperCase().contains('ZEBRA') ||
        brand.toUpperCase().contains('ZEBRA');
    final release = androidRelease.trim();
    final liveAndroid = release.isEmpty ? '' : 'Android $release';

    if (modelUpper.contains('MC3390')) {
      return const HandheldProfile(
        id: 'mc3390r',
        name: 'Zebra MC3300 Series (MC3390R)',
        androidVersion: 'Android 8.0 (Oreo)',
        note: 'เครื่องอ่าน RFID ในตัวเครื่อง',
        hasIntegratedRfid: true,
        usesZebraSdk: true,
        barcodeMethod: 'Zebra DataWedge SDK + เครื่องอ่าน UHF RFID',
        presenceName: 'Zebra MC3390R',
        modelKnown: true,
      );
    }
    if (modelUpper.contains('TC501')) {
      return HandheldProfile(
        id: 'tc501',
        name: 'Zebra TC501',
        androidVersion: liveAndroid,
        note: 'เครื่องอ่าน UHF RFID และสแกนบาร์โค้ดในตัวเครื่อง',
        hasIntegratedRfid: true,
        usesZebraSdk: true,
        barcodeMethod: 'Zebra DataWedge SDK + เครื่องอ่าน UHF RFID ในตัว',
        presenceName: 'Zebra TC501',
        modelKnown: true,
      );
    }
    if (modelUpper.contains('TC52')) {
      return HandheldProfile(
        id: 'tc52',
        name: 'Zebra TC52',
        androidVersion: liveAndroid,
        note: 'สแกนบาร์โค้ดในตัวเครื่อง · ไม่มี UHF RFID ในตัว',
        hasIntegratedRfid: false,
        usesZebraSdk: true,
        barcodeMethod: 'Zebra DataWedge SDK สำหรับปุ่มสแกนบาร์โค้ด',
        presenceName: 'Zebra TC52',
        modelKnown: true,
      );
    }
    if (zebra) {
      final label = ['Zebra', model.trim()].where((s) => s.isNotEmpty).join(' ');
      return HandheldProfile(
        id: 'zebra',
        name: label,
        androidVersion: liveAndroid,
        note: 'ไม่พบ UHF RFID ในตัวเครื่อง',
        hasIntegratedRfid: false,
        usesZebraSdk: true,
        barcodeMethod: 'Zebra DataWedge SDK สำหรับปุ่มสแกนบาร์โค้ด',
        presenceName: 'Zebra Handheld',
        modelKnown: modelUpper.isNotEmpty,
      );
    }
    final rawName = [manufacturer.trim(), model.trim()]
        .where((s) => s.isNotEmpty)
        .join(' ');
    return HandheldProfile(
      id: 'generic',
      name: rawName.isEmpty ? 'อุปกรณ์นี้' : rawName,
      androidVersion: liveAndroid,
      note: 'ไม่มีเครื่องอ่าน RFID ในตัวเครื่อง — ใช้บาร์โค้ดได้ตามปกติ',
      hasIntegratedRfid: false,
      usesZebraSdk: false,
      barcodeMethod: 'สแกนบาร์โค้ด/QR ด้วยอุปกรณ์สแกนหรือกรอกรหัสในแอป',
      presenceName: 'PDA Scanner',
      modelKnown: modelUpper.isNotEmpty,
    );
  }

  /// Profile stored in prefs, without a fresh Android model string.
  static HandheldProfile? capabilityFor(String id) {
    switch (id) {
      case 'mc3390r':
        return classify(
            model: 'MC3390R', manufacturer: 'Zebra', brand: 'Zebra');
      case 'tc501':
        return classify(model: 'TC501', manufacturer: 'Zebra', brand: 'Zebra');
      case 'tc52':
        return classify(model: 'TC52', manufacturer: 'Zebra', brand: 'Zebra');
      case 'zebra':
        return classify(model: 'TC21', manufacturer: 'Zebra', brand: 'Zebra');
      case 'generic':
        return classify(model: 'Phone', manufacturer: 'Other', brand: 'Other');
      default:
        return null;
    }
  }
}
