import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/services/device_address.dart';

void main() {
  test('prefers the Wi-Fi IPv4 over loopback, link-local and ethernet', () {
    expect(
      selectLanIpv4(const [
        (name: 'lo', addresses: ['127.0.0.1']),
        (name: 'eth0', addresses: ['10.0.0.8']),
        (name: 'wlan0', addresses: ['169.254.1.1', '192.168.1.52']),
      ]),
      '192.168.1.52',
    );
  });

  test('falls back to another private address when Wi-Fi has none', () {
    expect(
      selectLanIpv4(const [
        (name: 'eth0', addresses: ['10.1.2.3']),
      ]),
      '10.1.2.3',
    );
  });

  test('returns null when every address is unusable', () {
    expect(
      selectLanIpv4(const [
        (name: 'lo', addresses: ['127.0.0.1']),
        (name: 'wlan0', addresses: ['169.254.4.5', '0.0.0.0']),
      ]),
      isNull,
    );
  });
}
