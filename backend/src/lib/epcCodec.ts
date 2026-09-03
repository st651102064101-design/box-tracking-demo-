/**
 * ============================================================================
 * EPC hex -> barcode text
 * ----------------------------------------------------------------------------
 * Tags here are commissioned by writing the box's own barcode into the EPC
 * bank as ASCII, right-aligned and zero-padded to the tag's width — exactly
 * what GET /api/rfid/encode/:tag produces. `BOX-010` therefore comes back off
 * a reader as `00000000000000424F582D303130`.
 *
 * The PDA already decodes this locally (pda_flutter/lib/services/epc_codec.dart
 * — this file is the server-side twin, deliberately the same rules) but the
 * server could not: {@link resolveBoxesByCodes} only ever compared a code
 * against boxes.tag / rfid_epc / rfid_tid *verbatim*. That works for a tag
 * bound through POST /api/boxes/:tag/rfid, and fails for one that was encoded
 * and stuck on a box without ever being bound — which is the normal state of
 * things when tags are written in bulk. The barcode is sitting right there in
 * the hex; not reading it made the box look unknown to every endpoint that
 * takes a scan (gate in/out, cycle count, box lookup).
 * ============================================================================
 */

/** Decoded ASCII payload of an EPC, or null when the bytes aren't a plausible
 *  barcode — a numeric EPC or a tag written by another system carries no text,
 *  and inventing one would be worse than treating the read as unknown. */
export function epcToAscii(epcHex: string): string | null {
  const hex = epcHex.replace(/\s/g, '');
  if (!hex || hex.length % 2 !== 0) return null;
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;

  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));

  /* Left-hand zero padding only. A 0x00 *after* the text means this isn't an
     ASCII-encoded EPC at all, so it's rejected below rather than silently
     truncated at the null. */
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  const body = bytes.slice(start);
  if (body.length < 2) return null; // one character is noise, not a code

  for (const b of body) {
    if (b < 0x20 || b > 0x7e) return null; // printable ASCII only
  }
  const text = String.fromCharCode(...body).trim();
  if (text.length < 2) return null;
  // At least one alphanumeric, so a run of in-range punctuation isn't offered
  // up as if it were a barcode.
  if (!/[A-Za-z0-9]/.test(text)) return null;
  return text;
}

/** Width a barcode occupies at the right-hand end of an ASCII-encoded EPC —
 *  `BOX-010`, the shape every box tag has here. */
export const EPC_BARCODE_LENGTH = 7;

/**
 * Every box id an ASCII-encoded EPC could be carrying, best candidate first:
 * the whole decoded text, then the fixed-width right-hand slice, then each
 * shorter right-hand suffix down to two characters.
 *
 * The suffixes exist because some writers pad with the ASCII character `'0'`
 * (0x30) rather than the byte 0x00, so a clean decode arrives as
 * `00000BOX-010` and the zeros are indistinguishable from a barcode that
 * genuinely starts with one. Callers check each candidate against the box
 * table and take the first that exists, so a suffix is only ever adopted when
 * it names a real box.
 */
export function epcTagCandidates(epcHex: string): string[] {
  const text = epcToAscii(epcHex);
  if (text === null) return [];
  const out = [text];
  const fixed = text.length > EPC_BARCODE_LENGTH ? text.slice(-EPC_BARCODE_LENGTH) : text;
  if (fixed !== text) out.push(fixed);
  for (let len = text.length - 1; len >= 2; len--) {
    const s = text.slice(-len);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
