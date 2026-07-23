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
  final _triggerCtrl = StreamController<bool>.broadcast();
  final _statusCtrl = StreamController<RfidStatus>.broadcast();

  StreamSubscription? _sub;
  RfidState _state = RfidState.idle;
  RfidState get state => _state;

  Stream<String> get tags => _tagCtrl.stream;
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
          if (epc != null && epc.isNotEmpty) _tagCtrl.add(epc);
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
    } on PlatformException catch (e) {
      _state = RfidState.error;
      _statusCtrl.add(RfidStatus(RfidState.error, e.message ?? 'เชื่อมต่อไม่สำเร็จ'));
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

  void dispose() {
    _sub?.cancel();
    _tagCtrl.close();
    _triggerCtrl.close();
    _statusCtrl.close();
  }
}
