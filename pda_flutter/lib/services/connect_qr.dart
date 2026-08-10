import 'dart:convert';

/// What a "เชื่อมต่อระบบหลัก" QR code carries.
///
/// Provisioning used to mean typing `http://192.168.1.10:4000` on a handheld
/// keypad, on a device whose keyboard is deliberately suppressed everywhere
/// else in this app precisely because hand-typed values are wrong in ways
/// nobody notices. One transposed octet and the terminal fails to connect with
/// an error that looks identical to "the server is down" — so the admin
/// re-types it, gets it wrong again, and the device goes back in the drawer.
///
/// The web app (ตั้งค่า → เชื่อมต่อ PDA) prints this payload as a QR instead,
/// and the terminal reads it with the imager it already has.
class ConnectQr {
  final String baseUrl;

  /// The device's own service account. Optional: an admin who leaves it out of
  /// the QR is choosing to keep using whatever account the device already has.
  final String? username;

  /// Also optional, and off by default on the generator side — a printed QR
  /// carrying a password is a printed password. Supported because a fleet
  /// being provisioned from scratch otherwise still needs a typed secret per
  /// device, which is the exact problem this whole flow exists to remove.
  final String? password;

  const ConnectQr({required this.baseUrl, this.username, this.password});

  /// Marker prefix, versioned so a future payload shape can be told apart from
  /// this one rather than silently mis-parsed.
  static const prefix = 'BTCFG1:';

  /// Parses a scanned code, or returns null if it isn't a connection QR at all.
  ///
  /// Two accepted forms, because the second one costs nothing and covers every
  /// QR an admin might already have lying around (or generate elsewhere):
  ///   * `BTCFG1:{"url":"…","user":"…","pass":"…"}` — what the web app prints
  ///   * a bare `http://host:port` / `https://…` URL
  ///
  /// Anything else — a box barcode, an RFID tag, a shelf code — returns null,
  /// so a mis-aimed trigger pull is a no-op instead of a bad server address.
  static ConnectQr? parse(String raw) {
    final text = raw.trim();
    if (text.isEmpty) return null;

    if (text.startsWith(prefix)) {
      final body = text.substring(prefix.length).trim();
      Map<String, dynamic> m;
      try {
        final decoded = jsonDecode(body);
        if (decoded is! Map) return null;
        m = decoded.cast<String, dynamic>();
      } catch (_) {
        return null;
      }
      final url = _normalizeUrl(m['url']?.toString() ?? '');
      if (url == null) return null;
      return ConnectQr(
        baseUrl: url,
        username: _blankToNull(m['user']?.toString()),
        password: _blankToNull(m['pass']?.toString()),
      );
    }

    final url = _normalizeUrl(text);
    return url == null ? null : ConnectQr(baseUrl: url);
  }

  static String? _blankToNull(String? v) =>
      (v == null || v.trim().isEmpty) ? null : v.trim();

  /// Accepts only absolute http(s) URLs with a host. A trailing slash is
  /// dropped here rather than in ApiClient, so what the screen shows the admin
  /// is exactly what gets stored and used.
  static String? _normalizeUrl(String v) {
    var s = v.trim();
    if (s.isEmpty) return null;
    final uri = Uri.tryParse(s);
    if (uri == null) return null;
    if (uri.scheme != 'http' && uri.scheme != 'https') return null;
    if (uri.host.isEmpty) return null;
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }
}
