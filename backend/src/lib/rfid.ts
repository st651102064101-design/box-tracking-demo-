/**
 * Barcode <-> EPC hex conversion for writing/reading the RFID tag's EPC bank.
 *
 * Encoding is deliberately reversible and lossless: the barcode's raw UTF-8
 * bytes go straight into the low-order end of the EPC, left-padded with
 * zero bytes to fill the tag's bit width. That's why a near-empty tag reads
 * back as something like "000000000000000000000005" — it's barcode "5"
 * zero-padded to 96 bits, not a different encoding.
 */

const HEX_RE = /^[0-9A-Fa-f]*$/;

/** EPC memory sizes actually sold on Zebra-class UHF inlays. */
export const EPC_BITS = { EPC_96: 96, EPC_128: 128 } as const;
export type EpcBits = (typeof EPC_BITS)[keyof typeof EPC_BITS];

export class EpcEncodeError extends Error {}

/**
 * Barcode -> the hex string to write into the tag's EPC bank.
 *
 * @param barcode  e.g. "BOX-015". ASCII only — EPC Gen2 user memory is raw
 *                 bytes with no encoding negotiation, so anything outside
 *                 ASCII would round-trip ambiguously.
 * @param bits     Tag EPC bank width. Defaults to the common 96-bit inlay.
 */
export function encodeBarcodeToEpcHex(barcode: string, bits: EpcBits = EPC_BITS.EPC_96): string {
  if (!barcode) throw new EpcEncodeError('บาร์โค้ดว่างเปล่า');
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7F]*$/.test(barcode)) {
    throw new EpcEncodeError('บาร์โค้ดต้องเป็นตัวอักษร ASCII เท่านั้น (A-Z, 0-9, - เป็นต้น)');
  }

  const hexLen = bits / 4; // 4 bits per hex digit
  const bytes = Buffer.from(barcode, 'ascii');
  const raw = bytes.toString('hex').toUpperCase();
  if (raw.length > hexLen) {
    throw new EpcEncodeError(
      `บาร์โค้ด "${barcode}" ยาวเกินไปสำหรับแท็ก ${bits} บิต (สูงสุด ${hexLen / 2} ตัวอักษร)`,
    );
  }
  return raw.padStart(hexLen, '0');
}

/**
 * The inverse of {@link encodeBarcodeToEpcHex} — hex EPC read off a tag ->
 * the original barcode. Strips the leading zero-byte padding, then decodes
 * the remainder as ASCII. Returns '' for an all-zero (blank) tag.
 */
export function decodeEpcHexToBarcode(epcHex: string): string {
  const hex = epcHex.trim();
  if (!HEX_RE.test(hex) || hex.length % 2 !== 0) {
    throw new EpcEncodeError('EPC ไม่ใช่เลขฐาน 16 ที่ถูกต้อง');
  }
  // Strip whole leading zero bytes ("00"), not just leading zero nibbles —
  // a genuine barcode byte can itself be < 0x10 (unlikely for ASCII, but
  // keeps the pairing correct either way).
  let i = 0;
  while (i < hex.length - 1 && hex.slice(i, i + 2) === '00') i += 2;
  const trimmed = hex.slice(i);
  if (!trimmed || trimmed === '00') return '';
  return Buffer.from(trimmed, 'hex').toString('ascii');
}

/** True if `code` looks like hex (an EPC/TID scan) rather than a plain barcode. */
export function looksLikeHex(code: string): boolean {
  return code.length >= 8 && code.length % 2 === 0 && HEX_RE.test(code);
}
