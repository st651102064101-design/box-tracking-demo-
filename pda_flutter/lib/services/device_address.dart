import 'dart:io';

/// This handheld's own LAN address, for the dashboard IP column.
///
/// The server host in the connection URL is a different machine. Loopback
/// and 169.254 link-local addresses are not reachable from the warehouse
/// network, so they are skipped.
Future<String?> readDeviceLanIpv4() async {
  try {
    final ifaces = await NetworkInterface.list(
      includeLinkLocal: false,
      type: InternetAddressType.IPv4,
    );
    return selectLanIpv4([
      for (final iface in ifaces)
        (name: iface.name, addresses: iface.addresses.map((a) => a.address)),
    ]);
  } catch (_) {
    return null;
  }
}

/// Picks one IPv4 from [interfaces]. A Wi-Fi address wins over any other
/// private address, which wins over a public one.
String? selectLanIpv4(
    Iterable<({String name, Iterable<String> addresses})> interfaces) {
  String? private;
  String? other;
  for (final iface in interfaces) {
    final wifi = _isWifi(iface.name);
    for (final raw in iface.addresses) {
      final ip = raw.trim();
      if (!_usableV4(ip)) continue;
      if (wifi && _isPrivateV4(ip)) return ip;
      if (_isPrivateV4(ip)) {
        private ??= ip;
      } else {
        other ??= ip;
      }
    }
  }
  return private ?? other;
}

bool _isWifi(String name) {
  final n = name.toLowerCase();
  return n.contains('wlan') || n.contains('wifi') || n.contains('wi-fi');
}

bool _usableV4(String ip) {
  if (ip.isEmpty || ip == '0.0.0.0' || ip.contains(':')) return false;
  if (ip.startsWith('127.') || ip.startsWith('169.254.')) return false;
  final parts = ip.split('.');
  if (parts.length != 4) return false;
  return parts.every((p) {
    final n = int.tryParse(p);
    return n != null && n >= 0 && n <= 255;
  });
}

bool _isPrivateV4(String ip) {
  final p = ip.split('.');
  final a = int.parse(p[0]);
  final b = int.parse(p[1]);
  if (a == 10) return true;
  if (a == 192 && b == 168) return true;
  if (a == 172 && b >= 16 && b <= 31) return true;
  return false;
}
