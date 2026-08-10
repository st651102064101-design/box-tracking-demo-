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
}
