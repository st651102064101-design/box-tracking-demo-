import 'package:flutter_test/flutter_test.dart';

import 'package:boxtrace_pda/services/connect_qr.dart';

void main() {
  group('ConnectQr.parse', () {
    test('decodes the web app\'s tagged payload with url + password', () {
      final cfg = ConnectQr.parse(
          'BTCFG1:{"url":"http://192.168.1.10:4000/","pass":"secret"}');
      expect(cfg, isNotNull);
      expect(cfg!.baseUrl, 'http://192.168.1.10:4000'); // trailing slash dropped
      expect(cfg.password, 'secret');
    });

    test('a url-only payload leaves password null', () {
      final cfg =
          ConnectQr.parse('BTCFG1:{"url":"http://192.168.1.10:4000"}');
      expect(cfg, isNotNull);
      expect(cfg!.password, isNull);
    });

    test('a blank pass field in the payload is treated as absent', () {
      final cfg = ConnectQr.parse(
          'BTCFG1:{"url":"http://192.168.1.10:4000","pass":""}');
      expect(cfg, isNotNull);
      expect(cfg!.password, isNull);
    });

    // A "user" key is a leftover from an older/hand-built payload, not
    // something this parser ever reads — it's ignored, not rejected.
    test('a stray "user" key in the payload is ignored, not rejected', () {
      final cfg = ConnectQr.parse(
          'BTCFG1:{"url":"http://192.168.1.10:4000","user":"pda-01","pass":"secret"}');
      expect(cfg, isNotNull);
      expect(cfg!.baseUrl, 'http://192.168.1.10:4000');
      expect(cfg.password, 'secret');
    });

    test('a bare http(s) URL is accepted without the BTCFG1 prefix', () {
      final cfg = ConnectQr.parse('https://boxtrace.example.com:4000');
      expect(cfg, isNotNull);
      expect(cfg!.baseUrl, 'https://boxtrace.example.com:4000');
      expect(cfg.password, isNull);
    });

    test('a box barcode or shelf code is not a connection QR', () {
      expect(ConnectQr.parse('CRT-01'), isNull);
      expect(ConnectQr.parse('WH1-Z1-R01-S1'), isNull);
    });

    test('malformed JSON after the prefix does not parse', () {
      expect(ConnectQr.parse('BTCFG1:{not json'), isNull);
    });

    test('a prefixed payload with no usable url does not parse', () {
      expect(ConnectQr.parse('BTCFG1:{"pass":"secret"}'), isNull);
      expect(ConnectQr.parse('BTCFG1:{"url":""}'), isNull);
    });

    test('a non-http(s) scheme is rejected', () {
      expect(ConnectQr.parse('ftp://192.168.1.10:4000'), isNull);
      expect(ConnectQr.parse('not a url at all'), isNull);
    });

    test('empty input does not parse', () {
      expect(ConnectQr.parse(''), isNull);
      expect(ConnectQr.parse('   '), isNull);
    });
  });
}
