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

/// How many characters a barcode occupies at the right-hand end of an
/// ASCII-encoded EPC — `BOX-010`, the shape every box tag has here.
const epcBarcodeLength = 7;

/// The barcode itself: the rightmost [epcBarcodeLength] characters of what
/// [epcToAscii] decoded.
///
/// Some writers pad the EPC with the ASCII character `'0'` (0x30) instead of
/// the byte 0x00, so a clean decode comes back as `00000BOX-010` — the zeros
/// are literally part of the text and [epcToAscii] has no way to tell them
/// from a barcode that genuinely starts with a zero. Taking the last seven is
/// what separates them.
///
/// Note this is a fixed width by design: a box id shorter or longer than
/// seven characters would be cut wrong here, which is why the tag lookup in
/// AppController.resolveTag tries the full decode and every right-hand suffix
/// as well, and only uses this as one candidate among them.
String? epcBarcode(String epcHex) {
  final text = epcToAscii(epcHex);
  if (text == null) return null;
  if (text.length <= epcBarcodeLength) return text;
  return text.substring(text.length - epcBarcodeLength);
}

/// Every box id an ASCII-encoded EPC could be carrying, best candidate first:
/// the whole decoded text, then the fixed-width [epcBarcode], then each
/// right-hand suffix down to two characters.
///
/// The suffixes are what make a `'0'`-padded EPC work for a box id that isn't
/// seven characters long — `00000CRT-01` has to reach `CRT-01`, and a genuine
/// eight-character id has to survive being longer than [epcBarcodeLength].
/// Callers check these against the box list and take the first that exists,
/// so a suffix is only ever accepted when it names a real box.
List<String> epcTagCandidates(String epcHex) {
  final text = epcToAscii(epcHex);
  if (text == null) return const [];
  final out = <String>[text];
  final fixed = epcBarcode(epcHex);
  if (fixed != null && fixed != text) out.add(fixed);
  for (var len = text.length - 1; len >= 2; len--) {
    final s = text.substring(text.length - len);
    if (!out.contains(s)) out.add(s);
  }
  return out;
}

/// Whether a read's EPC carries [tag] as its ASCII payload — the same
/// candidate set [epcTagCandidates] produces, compared case-insensitively.
/// Used by the locate sweep, which matches reads itself instead of resolving
/// them through the box list.
bool epcMatchesTag(String epcHex, String tag) {
  final want = tag.trim().toUpperCase();
  if (want.isEmpty) return false;
  for (final c in epcTagCandidates(epcHex)) {
    if (c.toUpperCase() == want) return true;
  }
  return false;
}
