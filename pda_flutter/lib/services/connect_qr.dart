import 'dart:convert';

/// Parses the `BTCFG1:{...}` barcode/QR payload printed by the admin web
/// app's "เชื่อมต่อ PDA" screen (frontend/public/legacy.html, `pdaQrPayload`)
/// so a scanned code can fill in the device's server URL (and optional
/// service-account password) without anyone typing it by hand.
class ConnectQrResult {
  final String url;
  final String? pass;
  const ConnectQrResult({required this.url, this.pass});
}

class ConnectQr {
  static const prefix = 'BTCFG1:';

  /// Returns null if [text] isn't a recognized connect-QR payload — e.g. a
  /// box/shelf barcode scanned by mistake on this screen.
  static ConnectQrResult? parse(String text) {
    final trimmed = text.trim();
    if (!trimmed.startsWith(prefix)) return null;
    final jsonPart = trimmed.substring(prefix.length);
    Map<String, dynamic> obj;
    try {
      final decoded = jsonDecode(jsonPart);
      if (decoded is! Map<String, dynamic>) return null;
      obj = decoded;
    } catch (_) {
      return null;
    }
    final url = (obj['url'] ?? '').toString().trim();
    if (!RegExp(r'^https?://[^/\s]+').hasMatch(url)) return null;
    final pass = obj['pass']?.toString();
    return ConnectQrResult(url: url, pass: (pass == null || pass.isEmpty) ? null : pass);
  }
}
