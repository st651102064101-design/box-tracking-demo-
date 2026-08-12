import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

/// Live push from the backend's SSE endpoint (`GET /api/stream`) — the same
/// channel the web app's `connectStream()` uses, so a change from any client
/// (another PDA, the web app, a direct API call) reaches this device within
/// moments instead of waiting for the next local action to trigger a
/// refetch, or the operator restarting the app.
///
/// There's no `EventSource` outside a browser, so this hand-rolls the SSE
/// wire format (`event:`/`data:`/blank-line-terminated frames, `:`-prefixed
/// comments as heartbeats) on top of a streamed http request — simple enough
/// that a whole package for it isn't worth it. One upside over the browser:
/// a real `Authorization` header works here, so there's no need for the
/// token-in-query-string workaround `stream.ts` documents for EventSource.
class RealtimeService {
  final http.Client _client;
  StreamSubscription<String>? _sub;
  Timer? _retryTimer;
  bool _disposed = false;
  int _attempt = 0;

  RealtimeService({http.Client? client}) : _client = client ?? http.Client();

  static const _retryDelays = [2, 3, 5, 8, 13, 20];

  /// Starts (or restarts) the connection. Safe to call repeatedly — each
  /// call cancels whatever attempt/backoff was in flight and starts fresh,
  /// which is what a "device just got a new token" or "settings changed the
  /// server URL" moment needs.
  ///
  /// [onConnectivity], if given, fires true the moment the stream is
  /// actually open (proof the server answered) and false the moment it's
  /// lost — an SSE connection dies within moments of the server going away
  /// (or immediately on the next heartbeat gap), which makes this a genuine
  /// realtime up/down signal for AppController.connected rather than
  /// something that only ever finds out on the next unrelated REST call.
  void connect({
    required String Function() baseUrl,
    required String? Function() token,
    required void Function() onStateChanged,
    void Function(bool connected)? onConnectivity,
  }) {
    if (_disposed) return;
    _retryTimer?.cancel();
    _sub?.cancel();
    _attempt = 0;
    unawaited(_run(baseUrl, token, onStateChanged, onConnectivity));
  }

  Future<void> _run(
    String Function() baseUrl,
    String? Function() token,
    void Function() onStateChanged,
    void Function(bool connected)? onConnectivity,
  ) async {
    if (_disposed) return;
    final t = token();
    final base = baseUrl();
    if (t == null || t.isEmpty || base.isEmpty) {
      _scheduleRetry(baseUrl, token, onStateChanged, onConnectivity);
      return;
    }
    try {
      final b = base.endsWith('/') ? base.substring(0, base.length - 1) : base;
      final req = http.Request('GET', Uri.parse('$b/api/stream'));
      req.headers['Authorization'] = 'Bearer $t';
      final res = await _client.send(req).timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) {
        _scheduleRetry(baseUrl, token, onStateChanged, onConnectivity);
        return;
      }
      onConnectivity?.call(true);
      String? currentEvent;
      _sub = res.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
        (line) {
          if (line.isEmpty || line.startsWith(':')) {
            return; // frame end / heartbeat comment
          }
          if (line.startsWith('event:')) {
            currentEvent = line.substring(6).trim();
            return;
          }
          if (line.startsWith('data:')) {
            // A frame actually arriving (hello, state, or anything else)
            // proves the pipe is open end to end — reset backoff here, not
            // only on a fresh TCP connect, so a long-lived connection that's
            // been ticking over via heartbeats keeps a hair-trigger retry
            // the very next time it does drop.
            _attempt = 0;
            if (currentEvent == 'state') onStateChanged();
            currentEvent = null;
          }
        },
        onError: (_) =>
            _scheduleRetry(baseUrl, token, onStateChanged, onConnectivity),
        onDone: () =>
            _scheduleRetry(baseUrl, token, onStateChanged, onConnectivity),
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleRetry(baseUrl, token, onStateChanged, onConnectivity);
    }
  }

  void _scheduleRetry(
    String Function() baseUrl,
    String? Function() token,
    void Function() onStateChanged,
    void Function(bool connected)? onConnectivity,
  ) {
    if (_disposed) return;
    onConnectivity?.call(false);
    final delay = Duration(seconds: _retryDelays[_attempt]);
    if (_attempt < _retryDelays.length - 1) _attempt++;
    _retryTimer?.cancel();
    _retryTimer = Timer(delay,
        () => unawaited(_run(baseUrl, token, onStateChanged, onConnectivity)));
  }

  void dispose() {
    _disposed = true;
    _retryTimer?.cancel();
    _sub?.cancel();
    _client.close();
  }
}
