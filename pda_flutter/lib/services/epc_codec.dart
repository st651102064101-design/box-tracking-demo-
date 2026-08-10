/// EPC ⇄ barcode text.
///
/// Tags in this system are commissioned by writing the box's own barcode into
/// the EPC bank as ASCII, right-aligned and zero-padded to the tag's width —
/// that is exactly what `GET /api/rfid/encode/:tag` produces (see
/// `backend/src/routes/rfid.ts`), so `BOX-010` comes back off the reader as
/// `00000000000000424F582D303130`.
///
/// A screen showing a read is therefore showing a barcode nobody can read.
/// [epcToAscii] turns it back, and returns null rather than guessing whenever
/// the bytes are not a plausible barcode — a tag written by some other system
/// (or a plain numeric EPC) has no text in it, and inventing one would be
/// worse than showing the hex alone.
String? epcToAscii(String epcHex) {
  final hex = epcHex.replaceAll(RegExp(r'\s'), '');
  if (hex.isEmpty || hex.length.isOdd) return null;
  if (!RegExp(r'^[0-9A-Fa-f]+$').hasMatch(hex)) return null;

  final bytes = <int>[];
  for (var i = 0; i < hex.length; i += 2) {
    bytes.add(int.parse(hex.substring(i, i + 2), radix: 16));
  }

  // Drop the left-hand zero padding only. A 0x00 *after* text means this is
  // not an ASCII-encoded EPC at all, so the whole thing is rejected below
  // instead of being silently truncated at the null.
  var start = 0;
  while (start < bytes.length && bytes[start] == 0) {
    start++;
  }
  final body = bytes.sublist(start);
  if (body.length < 2) return null; // a single character is noise, not a code

  for (final b in body) {
    // printable ASCII only — space included (some codes carry one), DEL not
    if (b < 0x20 || b > 0x7E) return null;
  }
  final text = String.fromCharCodes(body).trim();
  if (text.length < 2) return null;

  // At least one letter or digit, so a run of punctuation that happens to be
  // in range doesn't get presented as if it were a barcode.
  if (!RegExp(r'[A-Za-z0-9]').hasMatch(text)) return null;
  return text;
}
