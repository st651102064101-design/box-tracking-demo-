import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

/// Connection state reported by the native Zebra RFID plugin.
enum RfidState { idle, connecting, connected, disconnected, error }

/// One selectable beep sound — the id crosses the platform channel and is
/// matched against RfidReaderController.playSoundIdBlocking's catalog on the
/// Kotlin side (a mix of synthesized PCM waveforms and ToneGenerator system
/// tones). Keep ids stable: they're what Prefs.rfidToneId persists.
class RfidTone {
  final String id;
  final String label;
  const RfidTone(this.id, this.label);
}

/// The beep catalog shown in Settings — every entry here must have a
/// matching branch in RfidReaderController.kt's playSoundIdBlocking, or it
/// silently falls back to the default there.
const kRfidTones = [
  RfidTone('html_tick', 'ติ๊กแบบ RFID HTML (ค่าเริ่มต้น)'),
  RfidTone('soft_tick', 'ติ๊กนุ่ม'),
  RfidTone('high_tick', 'ติ๊กแหลมสูง'),
  RfidTone('low_tick', 'ติ๊กทุ้มต่ำ'),
  RfidTone('ping', 'ปิ๊ง'),
  RfidTone('double_tick', 'ติ๊กคู่'),
  RfidTone('classic_beep', 'บี๊บคลาสสิก'),
  RfidTone('classic_ack', 'ป๊อกคลาสสิก'),
];

class RfidStatus {
  final RfidState state;
  final String message;
  const RfidStatus(this.state, this.message);
}

/// One raw tag read exactly as the Zebra SDK reported it — every field beyond
/// EPC is nullable because not all of them are populated on every read
/// (depends on tag type, reader session state, `setAttachTagDataWithReadEvent`).
/// This is the "what does the SDK actually give us" view used by the RFID
/// test-read screen in Settings and the RFID register/input screens; normal
/// scan flows still use the plain [RfidService.tags] stream.
class RfidTagRead {
  final String epc;
  final int? rssi;
  final String? tid;
  final int? pc;
  final String? crc;
  final int? antenna;
  final String? channel;
  final int? phase;
  final int? seenCount;
  final DateTime readAt;

  RfidTagRead({
    required this.epc,
    this.rssi,
    this.tid,
    this.pc,
    this.crc,
    this.antenna,
    this.channel,
    this.phase,
    this.seenCount,
    required this.readAt,
  });

  factory RfidTagRead.fromEvent(Map event, DateTime readAt) {
    return RfidTagRead(
      epc: event['epc']?.toString() ?? '',
      rssi: event['rssi'] as int?,
      tid: (event['tid'] as String?)?.isNotEmpty == true ? event['tid'] as String : null,
      pc: event['pc'] as int?,
      crc: (event['crc'] as String?)?.isNotEmpty == true ? event['crc'] as String : null,
      antenna: event['antenna'] as int?,
      channel: (event['channel'] as String?)?.isNotEmpty == true ? event['channel'] as String : null,
      phase: event['phase'] as int?,
      seenCount: event['seenCount'] as int?,
      readAt: readAt,
    );
  }
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
  final _rawTagCtrl = StreamController<RfidTagRead>.broadcast();
  final _batchCtrl = StreamController<List<RfidTagRead>>.broadcast();
  final _triggerCtrl = StreamController<bool>.broadcast();
  final _statusCtrl = StreamController<RfidStatus>.broadcast();
  final _chargingCtrl = StreamController<bool>.broadcast();

  StreamSubscription? _sub;
  RfidState _state = RfidState.idle;
  RfidState get state => _state;

  /// True while the terminal is on its charging cradle. The MC3390R firmware
  /// refuses every inventory command in that state, so this is not a battery
  /// readout — it is "the reader cannot fire right now, and here is why".
  /// Screens that arm the reader should say so rather than look broken.
  bool _charging = false;
  bool get charging => _charging;

  // ── Read buffer ────────────────────────────────────────────────────────
  // Reads land here as the raw maps the platform channel delivered, and
  // nothing else happens on that code path: no RfidTagRead built, no listener
  // run, no setState. Parsing and delivery wait for the next frame.
  //
  // The reason is that everything downstream of a read is per-read work that
  // the UI collapses anyway — a listener that inserts into a list and calls
  // setState rebuilds the whole list once per tag, and at reader speed that
  // rebuild is slower than the reads arriving. The buffer stops the read path
  // from being paced by whatever the slowest listener does with it.
  final List<Map> _buffer = [];
  DateTime? _bufferedAt;
  bool _flushScheduled = false;

  Stream<String> get tags => _tagCtrl.stream;
  /// Same tag reads as [tags], but with every raw SDK field attached — for the
  /// RFID test-read, register, and input screens, not for normal scan flows.
  Stream<RfidTagRead> get rawTags => _rawTagCtrl.stream;
  /// Alias of [rawTags] kept for screens written against the older name.
  Stream<RfidTagRead> get tagReads => _rawTagCtrl.stream;
  /// Every read buffered since the last frame, delivered as one list.
  ///
  /// Prefer this over [rawTags] on any screen that accumulates reads into a
  /// list: one event per frame means one `setState` per frame no matter how
  /// fast the reader is going, instead of one per tag.
  Stream<List<RfidTagRead>> get tagBatches => _batchCtrl.stream;
  Stream<bool> get triggers => _triggerCtrl.stream;
  Stream<RfidStatus> get status => _statusCtrl.stream;
  /// Emits on every cradle dock/undock (and once with the state at startup).
  Stream<bool> get chargingStates => _chargingCtrl.stream;

  bool get supported => defaultTargetPlatform == TargetPlatform.android;

  void _listen() {
    _sub ??= _events.receiveBroadcastStream().listen((event) {
      if (event is! Map) return;
      final type = event['type']?.toString();
      switch (type) {
        // One message carries a whole SDK read event. The native side stopped
        // sending a message per tag because each one cost an event-loop turn
        // on this isolate, which is what capped the read rate on a held
        // trigger — see RfidReaderController.eventReadNotify.
        case 'tags':
          final list = event['tags'];
          if (list is! List) break;
          // Buffer the raw maps and stop. Converting them to RfidTagRead and
          // waking listeners is deferred to _flush — see [_buffer].
          _buffer.addAll(list.whereType<Map>());
          _bufferedAt ??= DateTime.now();
          _scheduleFlush();
          break;
        case 'trigger':
          _triggerCtrl.add(event['pressed'] == true);
          break;
        case 'status':
          _state = _parseState(event['state']?.toString());
          _statusCtrl.add(RfidStatus(_state, event['message']?.toString() ?? ''));
          break;
        case 'charging':
          _charging = event['charging'] == true;
          _chargingCtrl.add(_charging);
          break;
      }
    }, onError: (e) {
      _state = RfidState.error;
      _statusCtrl.add(RfidStatus(RfidState.error, '$e'));
    });
  }

  /// Ask for one flush on the next frame, however many reads arrive before it.
  ///
  /// A post-frame callback (plus an explicit [SchedulerBinding.scheduleFrame],
  /// since an idle app schedules no frames of its own and the buffer would
  /// otherwise sit there until something else repainted) is the Flutter
  /// equivalent of `requestAnimationFrame`, and gives the same guarantee the
  /// HTML test page relies on: rendering happens at most once per frame no
  /// matter how fast reads land.
  void _scheduleFlush() {
    if (_flushScheduled) return;
    _flushScheduled = true;
    final binding = SchedulerBinding.instance;
    binding.addPostFrameCallback((_) {
      _flushScheduled = false;
      _flush();
    });
    binding.scheduleFrame();
  }

  /// Convert everything buffered since the last frame and deliver it once.
  void _flush() {
    if (_buffer.isEmpty) return;
    // Take the buffer out from under any read that lands mid-flush, so a tag
    // arriving while listeners run is kept for the next frame rather than
    // dropped or delivered twice.
    final pending = List<Map>.from(_buffer);
    final at = _bufferedAt ?? DateTime.now();
    _buffer.clear();
    _bufferedAt = null;

    final reads = <RfidTagRead>[];
    for (final raw in pending) {
      final epc = raw['epc']?.toString();
      if (epc == null || epc.isEmpty) continue;
      reads.add(RfidTagRead.fromEvent(raw, at));
    }
    if (reads.isEmpty) return;

    // The batch first, so a screen listening to it has the whole frame's worth
    // in hand before the per-tag streams start firing for the same reads.
    if (_batchCtrl.hasListener) _batchCtrl.add(reads);
    for (final r in reads) {
      _tagCtrl.add(r.epc);
      _rawTagCtrl.add(r);
    }
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
  /// Used only to restore the saved setting on connect — a percent can only
  /// ever land on ~101 of the reader's real power steps, so live dragging
  /// uses [setPowerIndex] instead (see settings_screen.dart's range slider).
  Future<void> setPowerPercent(int percent) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('setPower', {'percent': percent});
    } catch (_) {}
  }

  /// Diagnostic mode: report every tag field the SDK has, and chase a missing
  /// TID with an explicit access read.
  ///
  /// Off by default and worth keeping that way. The access read stops the
  /// inventory to run, and the full field set costs air time per tag, so
  /// leaving this on caps the read rate well below what the reader can do.
  /// Only the RFID tag-reader screen turns it on — and turns it back off when
  /// it leaves.
  Future<void> setDetailed(bool enabled) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('setDetailed', {'enabled': enabled});
    } catch (_) {}
  }

  /// Drop reads weaker than [dbm] (e.g. -55) natively, before they reach the
  /// app; null clears the filter.
  ///
  /// Transmit power alone doesn't decide which tag wins — at anything above a
  /// low setting the reader still hears tags across the room, and whichever
  /// answers first is the one the app sees. Pairing a low power with a floor
  /// here is what makes "hold the gun against the tag you mean" actually
  /// select that tag.
  Future<void> setRssiThreshold(int? dbm) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('setRssiThreshold', {'dbm': dbm});
    } catch (_) {}
  }

  /// Set the antenna transmit power as a raw index into the reader's own
  /// power table (0..[RfidReaderController.maxPower]) — every step the
  /// hardware actually has, not just the ~101 a percentage can reach.
  Future<void> setPowerIndex(int index) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('setPowerIndex', {'index': index});
    } catch (_) {}
  }

  /// Toggles the reader's own dense per-read tick — on for every screen
  /// that wants raw "how fast is this reading" feedback, off for Gate
  /// scanning, which drives its own discrete tones via [playTone] instead
  /// (see AppController._onReaderTrigger for where this gets flipped).
  Future<void> setAutoBeep(bool enabled) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('setAutoBeep', {'enabled': enabled});
    } catch (_) {}
  }

  /// One explicit, app-driven tone: 'ok' for a genuinely new tag/barcode
  /// landing in the queue, 'error' for a rejected/invalid scan. Both fixed
  /// and unconfigurable — a barcode-sourced Gate detection always sounds
  /// like this regardless of the operator's RFID tone choice; only a
  /// trigger-pulled RFID detection uses that configurable sound instead
  /// (see [playSound]). Silence (call nothing) is the correct response to
  /// a duplicate read — see AppController.addScan.
  Future<void> playTone(String kind) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('playTone', {'kind': kind});
    } catch (_) {}
  }

  /// Plays one sound id ([kRfidTones]) at [volumePercent] immediately, once
  /// — how a barcode-vs-RFID-sourced Gate detection ends up sounding
  /// different (AppController.addScan's `viaRfid`): an RFID trigger read
  /// plays the operator's chosen tone via this, a typed/scanned barcode
  /// always plays the fixed tone behind [playTone]('ok').
  Future<void> playSound(String soundId, {int volumePercent = 100}) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('playSound', {'soundId': soundId, 'volume': volumePercent});
    } catch (_) {}
  }

  /// Sets which tone id ([kRfidTones]) and volume (0-100) every subsequent
  /// beep() (dense per-read tick) and playTone() call uses — a reader-side
  /// setting that persists on the native side until this is called again,
  /// same pattern as setPowerIndex/setAutoBeep. Call once on connect/prefs
  /// load to restore a saved choice, and again immediately whenever the
  /// operator picks a different tone/volume in Settings.
  Future<void> setBeepStyle({required String toneId, required int volumePercent}) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('setBeepStyle', {'toneId': toneId, 'volume': volumePercent});
    } catch (_) {}
  }

  /// Plays [toneId] once at [volumePercent] immediately — the live preview
  /// behind Settings' tone picker ("เมื่อเลือกให้เล่นเสียงเลย"), independent of
  /// whatever setBeepStyle last configured so trying a tone never leaves the
  /// reader's standing style changed until the operator actually confirms it.
  Future<void> previewTone({required String toneId, required int volumePercent}) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('previewTone', {'toneId': toneId, 'volume': volumePercent});
    } catch (_) {}
  }

  /// Proximity beep for the locate/find-box screen: volume and pitch both
  /// scale with [level] (0..1, same normalized value the on-screen gauge
  /// uses) — a strong return beeps loud, a faint one barely ticks.
  Future<void> playLocateBeep(double level) async {
    if (!supported) return;
    try {
      await _method.invokeMethod('playLocateBeep', {'level': level});
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
    _buffer.clear();
    _tagCtrl.close();
    _rawTagCtrl.close();
    _batchCtrl.close();
    _triggerCtrl.close();
    _statusCtrl.close();
    _chargingCtrl.close();
  }
}
