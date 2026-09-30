/// Cleans a string the barcode SDK just decoded.
///
/// DataWedge often delivers the label plus bytes that are not part of the
/// box id: a trailing CR the wedge uses as "enter", and an AIM symbology
/// prefix such as `]C1` / `]d2`. Those bytes are real scan data — they show
/// up — but they are not the tag, so a gate-out lookup misses the box.
String normalizeScanPayload(String raw) {
  var s = raw.replaceAll(RegExp(r'[\u0000-\u001F\u007F]'), '').trim();
  final aim = RegExp(r'^\][A-Za-z][0-9A-Za-z]');
  if (s.length > 3 && aim.hasMatch(s)) {
    s = s.substring(3).trim();
  }
  return s;
}
