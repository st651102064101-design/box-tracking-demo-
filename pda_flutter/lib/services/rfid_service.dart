import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Connection state reported by the native Zebra RFID plugin.
enum RfidState { idle, connecting, connected, disconnected, error }

class RfidStatus {
  final RfidState state;
  final String message;
  const RfidStatus(this.state, this.message);
}

/// One tag read, EPC plus (when the reader could get it) the factory TID —
/// see [RfidService.tagReads]. [tags] only ever carried the EPC, which is
/// all the original scan-and-match use cases needed; RFID *registration*
/// needs the TID too, since that's the actually-unique identifier for the
/// physical chip.
class RfidTagRead {
  final String epc;
  final String? tid;
  final int? rssi;
  const RfidTagRead(this.epc, this.tid, this.rssi);
}

/// Dart facade over the native Zebra RFIDAPI3 reader (see
/// `android/app/src/main/kotlin/.../RfidPlugin.kt`).
///
/// - [tags] streams EPC hex strings as the reader inventories.
/// - [triggers] streams the physical gun-trigger press/release.
/// - [status] streams connection state changes.
///
/// On non-Android platforms (or when no reader is present) the methods degrade
/// gracefully to no-ops so the rest of the app — manual entry + the simulator —
/// keeps working for development.
class RfidService {
  static const _method = MethodChannel('boxtrace/rfid');
  static const _events = EventChannel('boxtrace/rfid/events');

  final _tagCtrl = StreamController<String>.broadcast();
  final _tagReadCtrl = StreamController<RfidTagRead>.broadcast();
  final _triggerCtrl = StreamController<bool>.broadcast();
  final _statusCtrl = StreamController<RfidStatus>.broadcast();

  StreamSubscription? _sub;
  RfidState _state = RfidState.idle;
  RfidState get state => _state;

  Stream<String> get tags => _tagCtrl.stream;
  Stream<RfidTagRead> get tagReads => _tagReadCtrl.stream;
  Stream<bool> get triggers => _triggerCtrl.stream;
  Stream<RfidStatus> get status => _statusCtrl.stream;

  bool get supported => defaultTargetPlatform == TargetPlatform.android;

  void _listen() {
    _sub ??= _events.receiveBroadcastStream().listen((event) {
      if (event is! Map) return;
      final type = event['type']?.toString();
      switch (type) {
        case 'tag':
          final epc = event['epc']?.toString();
          if (epc != null && epc.isNotEmpty) {
            _tagCtrl.add(epc);
            final tid = event['tid']?.toString();
            final rssi = event['rssi'] is int ? event['rssi'] as int : null;
            _tagReadCtrl.add(RfidTagRead(epc, (tid != null && tid.isNotEmpty) ? tid : null, rssi));
          }
          break;
        case 'trigger':
          _triggerCtrl.add(event['pressed'] == true);
          break;
        case 'status':
          _state = _parseState(event['state']?.toString());
          _statusCtrl.add(RfidStatus(_state, event['message']?.toString() ?? ''));
          break;
      }
    }, onError: (e) {
      _state = RfidState.error;
      _statusCtrl.add(RfidStatus(RfidState.error, '$e'));
    });
  }

  RfidState _parseState(String? s) {
    switch (s) {
      case 'connecting':
        return RfidState.connecting;
      case 'connected':
        return RfidState.connected;
      case 'disconnected':
        return RfidState.disconnected;
      case 'error':
        return RfidState.error;
      default:
        return RfidState.idle;
    }
  }

  /// Enumerate + connect to the integrated reader (MC3390R via SERVICE_SERIAL).
  Future<void> connect() async {
    if (!supported) {
      _statusCtrl.add(const RfidStatus(RfidState.idle, 'RFID ใช้ได้เฉพาะบนเครื่อง Android'));
      return;
    }
    _listen();
    _state = RfidState.connecting;
    _statusCtrl.add(const RfidStatus(RfidState.connecting, 'กำลังเชื่อมต่อเครื่องอ่าน…'));
    try {
      await _method.invokeMethod('connect');
    } catch (e) {
      // Not just PlatformException: an Android build without the Zebra
      // libraries — or any host running the app off-device — answers with
      // MissingPluginException, and an unhandled async throw there would take
      // down a screen that works perfectly well with manual entry.
      _state = RfidState.error;
      final msg = e is PlatformException ? (e.message ?? '') : '';
      _statusCtrl.add(RfidStatus(RfidState.error, msg.isEmpty ? 'ไม่พบเครื่องอ่านบนอุปกรณ์นี้' : msg));
    }
  }

  Future<void> disconnect() async {
    if (!supported) return;
    try {
      await _method.invokeMethod('disconnect');
    } catch (_) {}
  }

  /// Start an inventory sweep (equivalent to holding the trigger).
  Future<void> startInventory() async {
    if (!supported) return;
    try {
      await _method.invokeMethod('startInventory');
    } catch (_) {}
  }

  Future<void> stopInventory() async {
    if (!supported) return;
    try {
      await _method.invokeMethod('stopInventory');
    } catch (_) {}
  }

  /// Set the antenna transmit power as a percentage (0–100) of the reader max.
  Future<void> setPowerPercent(int percent) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('setPower', {'percent': percent});
    } catch (_) {}
  }

  Future<bool> isConnected() async {
    if (!supported) return false;
    try {
      return (await _method.invokeMethod<bool>('isConnected')) ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Everything the native side knows about the reader right now — model,
  /// firmware, region, transmit power, tags seen, last error. Empty when there
  /// is no reader to ask (desktop/web, or a phone with no Zebra hardware).
  ///
  /// This is what turns "I don't know whether RFID works on this device" into a
  /// screen of facts the first time a terminal is switched on.
  Future<Map<String, dynamic>> diagnostics() async {
    if (!supported) return const {};
    try {
      final r = await _method.invokeMapMethod<String, dynamic>('diagnostics');
      return r ?? const {};
    } catch (_) {
      return const {};
    }
  }

  void dispose() {
    _sub?.cancel();
    _tagCtrl.close();
    _tagReadCtrl.close();
    _triggerCtrl.close();
    _statusCtrl.close();
  }
}
