import 'package:flutter_test/flutter_test.dart';

import 'package:boxtrace_pda/services/epc_codec.dart';

void main() {
  group('epcToAscii', () {
    test('decodes a zero-padded ASCII EPC back to its barcode', () {
      // exactly what GET /api/rfid/encode/BOX-010 writes to the tag
      expect(epcToAscii('00000000000000424F582D303130'), 'BOX-010');
      expect(epcToAscii('000000000000424F582D3031'), 'BOX-01');
    });

    test('is case-insensitive about the hex itself', () {
      expect(epcToAscii('000000000000424f582d3031'), 'BOX-01');
    });

    test('leaves a tag that carries no text alone', () {
      // plain numeric EPC — 0x05 is not printable, so there is nothing to show
      expect(epcToAscii('000000000000000000000005'), isNull);
      // a real-world EPC from another system
      expect(epcToAscii('E280691500007006A375143E'), isNull);
    });

    test('rejects anything that is not clean hex', () {
      expect(epcToAscii(''), isNull);
      expect(epcToAscii('BOX-010'), isNull);
      expect(epcToAscii('424F58'.substring(0, 5)), isNull); // odd length
    });

    test('rejects a null byte sitting after the text', () {
      // 'AB' then 0x00 — not the padding shape, so not an ASCII EPC
      expect(epcToAscii('414200'), isNull);
    });

    test('rejects punctuation-only and single-character payloads', () {
      expect(epcToAscii('00002D2D'), isNull); // '--'
      expect(epcToAscii('000000000000000000000041'), isNull); // 'A'
    });
  });

  group('epcBarcode — the rightmost 7 characters', () {
    test("drops '0' padding that decoded as text", () {
      // 00000BOX-010 — the zeros are ASCII 0x30, part of the decoded string
      expect(epcToAscii('3030303030424F582D303130'), '00000BOX-010');
      expect(epcBarcode('3030303030424F582D303130'), 'BOX-010');
    });

    test('the exact space-separated read reported on the reader', () {
      // 30 30 30 30 30 42 4f 58 2d 30 31 30 -> "00000BOX-010" -> "BOX-010"
      expect(epcBarcode('30 30 30 30 30 42 4f 58 2d 30 31 30'), 'BOX-010');
    });

    test('leaves a code that is already 7 or fewer characters alone', () {
      expect(epcBarcode('000000000000424F582D3031'), 'BOX-01');
      expect(epcBarcode('00000000000000424F582D303130'), 'BOX-010');
    });

    test('passes through a tag with no text at all', () {
      expect(epcBarcode('E280691500007006A375143E'), isNull);
    });
  });

  group('epcTagCandidates / epcMatchesTag', () {
    test('offers the whole text, the 7-char slice, then shorter suffixes', () {
      final c = epcTagCandidates('3030303030424F582D303130'); // 00000BOX-010
      expect(c.first, '00000BOX-010');
      expect(c, contains('BOX-010'));
      expect(c.last.length, 2);
    });

    test('reaches a box id shorter than 7 characters', () {
      // 00000CRT-01 — the 7-char slice would be '0CRT-01', the suffix is right
      expect(epcMatchesTag('30303030304352542D3031', 'CRT-01'), isTrue);
    });

    test('reaches a box id longer than 7 characters', () {
      expect(epcMatchesTag('424F582D30313030', 'BOX-0100'), isTrue);
    });

    test('is case-insensitive and rejects a tag that is not in the payload',
        () {
      expect(epcMatchesTag('3030303030424F582D303130', 'box-010'), isTrue);
      expect(epcMatchesTag('3030303030424F582D303130', 'BOX-011'), isFalse);
      expect(epcMatchesTag('E280691500007006A375143E', 'BOX-010'), isFalse);
    });
  });
}
