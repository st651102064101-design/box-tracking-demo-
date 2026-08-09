import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/i18n.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_capture.dart';

/// "Find this box" — pick a box by tag/type, then sweep the reader like a
/// Geiger counter: every read that matches the box's own EPC (or TID, if it
/// has one) moves a signal-strength meter, closest reads bubble to the top of
/// a card, and it beeps/vibrates faster the stronger the return gets. Answers
/// "is this box in this zone" without knowing exactly where in a rack of
/// hundreds it's sitting — walk the aisle, watch the meter climb.
///
/// Two steps in one screen (no separate route) so losing the reader
/// connection or picking the wrong box is a tap away, not a full navigation:
///  1. [_Step.pick]   — search boxes by tag/type, same list UX as TrackScreen.
///  2. [_Step.locate] — hold the trigger, watch the meter.
class RfidLocateScreen extends StatefulWidget {
  const RfidLocateScreen({super.key});
  @override
  State<RfidLocateScreen> createState() => _RfidLocateScreenState();
}

enum _Step { pick, locate }

class _RfidLocateScreenState extends State<RfidLocateScreen> {
  /// Set when a scanned code doesn't resolve to a taggable box — shown under
  /// the scan prompt until the next scan replaces or clears it.
  String? _scanError;

  _Step _step = _Step.pick;
  Box? _target;

  /// Pick-step RFID sweep census: every distinct tagged box the trigger has
  /// found this sweep, in first-seen order — answers "how many tagged boxes
  /// are in this area" on its own, not just "is this one specific box here."
  /// Tapping an entry still moves into the locate/gauge step for that box.
  final List<String> _sweepTags = [];

  StreamSubscription<List<RfidTagRead>>? _tagSub;
  StreamSubscription<RfidStatus>? _statusSub;
  StreamSubscription<bool>? _triggerSub;
  late RfidStatus _status;
  bool _reading = false;

  // Last matched read and a short rolling max, so the needle doesn't flicker
  // to zero the instant one read in a fast stream is missed — it decays on
  // its own timer instead (see [_tick]) rather than resetting per-batch.
  int? _rssi;
  DateTime? _lastHitAt;
  int _hits = 0;
  Timer? _decayTimer;
  DateTime? _lastHapticAt;
  DateTime? _lastGradeSoundAt;

  // Reader's realistic dBm range on this hardware (see rfid_input_screen /
  // the RFID test sheet for raw values on the terminal) — clamps the meter
  // to something that actually moves across a room instead of pinning at the
  // extremes for every read.
  //
  // Widened from the original -70/-30: a passive UHF tag's peak RSSI rarely
  // gets stronger than about -40dBm even held right against the antenna
  // (-30dBm is close to this reader's own overload/saturation floor), so a
  // "found" threshold built on -30 as "close" was only ever reachable with
  // the tag pressed flat against the reader — reported as "gauge won't move
  // unless you're touching it." -85 as "far" also gives real distance reads
  // (which land in the -75..-90dBm range on this hardware at a few meters,
  // not down at -70) somewhere to register on the meter instead of clamping
  // to zero the moment they're not already close.
  static const _rssiFar = -85;
  static const _rssiClose = -45;
  static const _staleAfter = Duration(milliseconds: 900);

  @override
  void initState() {
    super.initState();
    final c = context.read<AppController>();
    // Unlike Scan/Track — which deliberately let scanInputMode carry over
    // between visits — this screen always starts on บาร์โค้ด. It's the
    // "pick a box" step's default entry point (searching by tag/type is the
    // common case), and scanInputMode is shared app-wide state, so without
    // this a previous RFID pick on Scan or Track would leak in here as the
    // starting mode too.
    c.setScanInputMode(ScanInputMode.barcode);
    final rfid = c.rfid;
    _status = RfidStatus(rfid.state, '');
    _tagSub = rfid.tagBatches.listen(_onBatch);
    _statusSub = rfid.status.listen((s) {
      if (mounted) setState(() => _status = s);
    });
    // Physical trigger is wired centrally (AppController._onReaderTrigger
    // allows Screen.rfidLocate to start inventory) — mirror it here purely so
    // the on-screen button/label track a trigger pull too.
    _triggerSub = rfid.triggers.listen((pressed) {
      if (mounted) setState(() => _reading = pressed);
    });
    if (rfid.supported && rfid.state != RfidState.connected) {
      rfid.connect();
    }
    _decayTimer =
        Timer.periodic(const Duration(milliseconds: 200), (_) => _tick());
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _forceMaxRangeAndNotify());
  }

  /// Every time this screen is opened: push the reader's transmit power to
  /// its own max (a sweep search needs every bit of range it can get,
  /// regardless of whatever ใกล้/ปานกลาง/ไกล pick Settings last saved) and
  /// tell the operator it happened — "ทุกครั้ง" per the ask, not just the
  /// first visit, since the setting could have been dialed back again since.
  Future<void> _forceMaxRangeAndNotify() async {
    final c = context.read<AppController>();
    await c.forceMaxRfidPower();
    if (!mounted) return;
    if (c.prefs.hideMaxRangeAlert) return;
    final loc = context.read<LocaleController>();
    bool dontShowAgain = false;
    await showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(loc.t('ตั้งระยะยิงสูงสุด')),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(loc.t(
                  'ระบบตั้งกำลังส่งสัญญาณของเครื่องอ่านไว้ที่ระยะไกลสุดโดยอัตโนมัติ '
                  'เพื่อให้กวาดหากล่องได้ไกลที่สุดเท่าที่เครื่องรองรับ')),
              const SizedBox(height: 12),
              InkWell(
                onTap: () =>
                    setDialogState(() => dontShowAgain = !dontShowAgain),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Checkbox(
                      value: dontShowAgain,
                      onChanged: (v) =>
                          setDialogState(() => dontShowAgain = v ?? false),
                    ),
                    Flexible(child: Text(loc.t('ไม่ต้องแสดงอีก'))),
                  ],
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () {
                if (dontShowAgain) c.prefs.hideMaxRangeAlert = true;
                Navigator.of(ctx).pop();
              },
              child: Text(loc.t('เข้าใจแล้ว')),
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    // Clear rather than leave dangling: a stray system-back press after
    // this screen is gone must not invoke a closure that calls setState on
    // an unmounted State.
    final c = context.read<AppController>();
    if (identical(c.systemBackOverride, _handleBack))
      c.systemBackOverride = null;
    c.rfidLocateSweepStep = false;
    _tagSub?.cancel();
    _statusSub?.cancel();
    _triggerSub?.cancel();
    _decayTimer?.cancel();
    super.dispose();
  }

  /// Registered as AppController.systemBackOverride whenever this screen is
  /// on the .locate step (see build) — the system back control has to land
  /// on the same "back to picking a box" behavior the StickyHeader arrow
  /// already uses there, not AppController's default backToHome().
  void _handleBack() => _changeTarget(context.read<AppController>());

  void _onBatch(List<RfidTagRead> batch) {
    if (_step == _Step.pick) {
      _onPickBatch(batch);
      return;
    }
    if (_target == null) return;
    final wantEpc = _target!.rfidEpc?.toUpperCase();
    final wantTid = _target!.rfidTid?.toUpperCase();
    if ((wantEpc == null || wantEpc.isEmpty) &&
        (wantTid == null || wantTid.isEmpty)) return;

    int? best;
    for (final r in batch) {
      final epc = r.epc.toUpperCase();
      final tid = r.tid?.toUpperCase();
      final isMatch =
          (wantEpc != null && wantEpc.isNotEmpty && epc == wantEpc) ||
              (wantTid != null && wantTid.isNotEmpty && tid == wantTid);
      if (!isMatch) continue;
      final rssi = r.rssi ??
          _rssiClose; // no RSSI field on this read: treat as a direct hit
      if (best == null || rssi > best) best = rssi;
    }
    final matched = best;
    if (matched == null) return;

    final now = DateTime.now();
    setState(() {
      _rssi = matched;
      _lastHitAt = now;
      _hits++;
    });

    // Haptic "click" scales with proximity like a Geiger counter, throttled
    // so a 170-reads/sec stream doesn't turn into a solid vibration.
    final level = _normalize(matched);
    final minGap = Duration(milliseconds: (260 - (level * 200)).round());
    if (_lastHapticAt == null || now.difference(_lastHapticAt!) >= minGap) {
      _lastHapticAt = now;
      if (level > 0.75) {
        HapticFeedback.mediumImpact();
      } else {
        HapticFeedback.selectionClick();
      }
    }

    // Audible "grade" ladder over the same signal: same four tiers as
    // _proximityLabel, each a distinct, more urgent tone so a walking
    // operator can track "did the grade go up" by ear without watching the
    // gauge. Throttled on its own timer (not reused from haptics — a sound
    // needs longer to actually be heard as separate ticks than a vibration
    // does) so a strong, steady signal doesn't turn into a solid tone.
    final soundGap = Duration(milliseconds: (320 - (level * 220)).round());
    if (_lastGradeSoundAt == null ||
        now.difference(_lastGradeSoundAt!) >= soundGap) {
      _lastGradeSoundAt = now;
      final soundId = level > 0.75
          ? 'grade_found'
          : level > 0.55
              ? 'grade_close'
              : level > 0.25
                  ? 'grade_warm'
                  : 'grade_far';
      context.read<AppController>().rfid.playSound(soundId);
    }
  }

  /// RFID-mode picking: every distinct tagged box the trigger turns up joins
  /// the running sweep list (AppController.resolveTag already matches by
  /// rfidEpc/rfidTid, not just the barcode key) — this is a census of what's
  /// in range, not a race to the first hit, so it no longer jumps straight
  /// into the locate step on its own. Tapping an entry in that list is what
  /// moves on to locate/gauge for that one box.
  void _onPickBatch(List<RfidTagRead> batch) {
    final c = context.read<AppController>();
    if (c.scanInputMode != ScanInputMode.rfid) return;
    final s = c.S;
    if (s == null) return;
    var changed = false;
    for (final r in batch) {
      final tag = c.resolveTag(r.epc);
      final b = s.box(tag);
      if (b == null) continue;
      final hasTag =
          (b.rfidEpc?.isNotEmpty ?? false) || (b.rfidTid?.isNotEmpty ?? false);
      if (!hasTag) continue;
      if (_sweepTags.contains(tag)) continue;
      _sweepTags.add(tag);
      changed = true;
    }
    if (changed && mounted) setState(() {});
  }

  /// Runs off a timer, not off reads, because "no read arrived" is itself the
  /// signal the meter has to show (falling back to zero) — a stream listener
  /// alone only ever fires when something *was* seen.
  void _tick() {
    if (_rssi == null || _lastHitAt == null) return;
    if (DateTime.now().difference(_lastHitAt!) > _staleAfter) {
      setState(() => _rssi = null);
    }
  }

  double _normalize(int rssi) {
    final v = (rssi - _rssiFar) / (_rssiClose - _rssiFar);
    return v.clamp(0.0, 1.0);
  }

  Future<void> _toggleRead(AppController c) async {
    if (!c.rfid.supported) return;
    if (_reading) {
      await c.rfid.stopInventory();
      setState(() => _reading = false);
    } else {
      setState(() => _reading = true);
      await c.rfid.startInventory();
    }
  }

  /// A box's own barcode, straight off the imager — the only way the pick
  /// step resolves a target now (see [_pickBody]). A picking ticket or an
  /// existing pallet label both carry a real, scannable code; typing one was
  /// the thing that let a mistyped tag jump straight into a sweep for the
  /// wrong box. Jumps straight into the sweep step on a match, same as
  /// tapping that box in the list below would.
  void _onScan(AppController c, String raw) {
    final loc = context.read<LocaleController>();
    final s = c.S;
    if (s == null) return;
    final b = s.box(c.resolveTag(raw));
    if (b == null) {
      setState(() => _scanError = '${loc.t('ไม่พบกล่องรหัส')} "$raw"');
      return;
    }
    final hasTag =
        (b.rfidEpc?.isNotEmpty ?? false) || (b.rfidTid?.isNotEmpty ?? false);
    if (!hasTag) {
      setState(() =>
          _scanError = '${b.tag} ${loc.t('ยังไม่ได้ผูกแท็ก RFID — หาไม่ได้')}');
      return;
    }
    setState(() => _scanError = null);
    _pick(c, b);
  }

  void _pick(AppController c, Box b) {
    setState(() {
      _target = b;
      _step = _Step.locate;
      _rssi = null;
      _lastHitAt = null;
      _hits = 0;
    });
    // The sweep step has no barcode alternative — it only makes sense as an
    // RFID proximity search — so it always needs the trigger to actually
    // fire regardless of what the pick step's toggle was last set to.
    // rfidLocateSweepStep is the authoritative signal for that (see
    // AppController._onReaderTrigger); setScanInputMode alone wasn't enough,
    // since anything that flipped the shared mode back to barcode left the
    // trigger dead on a screen with no barcode path at all.
    c.rfidLocateSweepStep = true;
    c.setScanInputMode(ScanInputMode.rfid);
  }

  void _changeTarget(AppController c) {
    c.rfid.stopInventory();
    c.rfidLocateSweepStep = false;
    setState(() {
      _step = _Step.pick;
      _target = null;
      _reading = false;
      _scanError = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    // Kept in sync every rebuild rather than only in initState/step
    // transitions — cheap, and guarantees a system back press always
    // matches whatever the StickyHeader arrow below would do right now.
    c.systemBackOverride = _step == _Step.locate ? _handleBack : null;
    return ScanCapture(
      // Live on the pick step, in บาร์โค้ด mode, only — the locate step is
      // RFID-only by definition and drives its own reader stream instead.
      enabled: _step == _Step.pick && c.scanInputMode == ScanInputMode.barcode,
      onScan: (raw) => _onScan(c, raw),
      child: AutoHideHeader(
        header: StickyHeader(
          onBack: _step == _Step.locate ? () => _changeTarget(c) : c.backToHome,
          title: Text(loc.t('หากล่อง / RFID')),
          subtitle: Text(loc
              .t(_step == _Step.pick ? 'เลือกกล่องที่จะหา' : 'กวาดหาสัญญาณ')),
        ),
        body: Column(
          children: [
            Expanded(
              child:
                  _step == _Step.pick ? _pickBody(c, loc) : _locateBody(c, loc),
            ),
          ],
        ),
      ),
    );
  }

  // ── Step 1: pick ──────────────────────────────────────────────────────
  Widget _pickBody(AppController c, LocaleController loc) {
    final bottom = MediaQuery.of(context).padding.bottom;
    // Every taggable box, browsable without typing anything — this is what a
    // scan-only pick step falls back to when there's no picking ticket or
    // pallet label in hand to scan.
    final tagged = (c.S?.boxes.toList() ?? const <Box>[])
        .where((b) =>
            (b.rfidEpc?.isNotEmpty ?? false) ||
            (b.rfidTid?.isNotEmpty ?? false))
        .toList()
      ..sort((a, b) => a.tag.compareTo(b.tag));

    return ListView(
      padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
      children: [
        _inputModeToggle(c, loc),
        const SizedBox(height: 11),
        if (c.scanInputMode == ScanInputMode.barcode) ...[
          // No field: a picking ticket or an existing pallet label carries a
          // real, scannable code, and typing one is what let a mistyped tag
          // jump into a sweep for the wrong box. Nothing to scan in hand?
          // Tap a box straight off the list below instead.
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 18),
            decoration: BoxDecoration(
              color: C.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: C.fieldBorder, width: 1.5),
            ),
            child: Row(
              children: [
                Icon(Icons.qr_code_scanner, color: C.muted),
                const SizedBox(width: 11),
                Expanded(
                  child: Text(loc.t('ยิงบาร์โค้ดกล่องที่จะหา'),
                      style: TextStyle(
                          fontSize: 14,
                          color: C.muted,
                          fontWeight: FontWeight.w600)),
                ),
              ],
            ),
          ),
          if (_scanError != null) ...[
            const SizedBox(height: 8),
            Text(_scanError!,
                style: TextStyle(
                    fontSize: 13, color: C.red, fontWeight: FontWeight.w600)),
          ],
        ] else
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 22),
            decoration: BoxDecoration(
              color: _reading ? C.limeBg : C.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                  color: _reading ? C.limeBorder : C.fieldBorder, width: 1.5),
            ),
            child: Column(
              children: [
                Icon(Icons.wifi_tethering,
                    size: 22, color: _reading ? C.limeDeep : C.muted),
                const SizedBox(height: 6),
                Text(
                    loc.t(_reading
                        ? 'กำลังกวาดหา…'
                        : 'เหนี่ยวไกกวาดหากล่องในบริเวณนี้ — หรือยิงแท็กของกล่องที่จะหา'),
                    style: TextStyle(
                        fontSize: 13,
                        color: _reading ? C.limeDeep : C.muted,
                        fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        const SizedBox(height: 14),
        if (c.scanInputMode != ScanInputMode.barcode)
          ..._sweepList(c, loc)
        else if (tagged.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 4),
            child: Text(loc.t('ยังไม่มีกล่องที่ผูกแท็ก RFID ในระบบ'),
                style: TextStyle(fontSize: 13, color: C.faint, height: 1.4)),
          )
        else ...[
          Text(loc.t('หรือเลือกจากรายการ'),
              style: TextStyle(
                  fontSize: 12, fontWeight: FontWeight.w700, color: C.muted)),
          const SizedBox(height: 8),
          Container(
            decoration: BoxDecoration(
              color: C.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: C.border),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: List.generate(tagged.length, (i) {
                final b = tagged[i];
                final sm = StatusMeta.of(b.status);
                return InkWell(
                  onTap: () => _pick(c, b),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      border: i == tagged.length - 1
                          ? null
                          : Border(bottom: BorderSide(color: C.border)),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.nfc, size: 18, color: C.muted),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(b.tag,
                                  style: const TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w700,
                                      fontFamily: 'monospace')),
                              Text(c.S!.typeName(b.type),
                                  style:
                                      TextStyle(fontSize: 12, color: C.muted)),
                            ],
                          ),
                        ),
                        Pill(sm.label,
                            color: sm.color, bg: sm.bg, fontSize: 11),
                      ],
                    ),
                  ),
                );
              }),
            ),
          ),
        ],
      ],
    );
  }

  /// The running census of tagged boxes the sweep has found so far — see
  /// [_sweepTags]. Empty and non-empty states both render inline (not a
  /// separate step) since the count itself, updating live while the trigger
  /// is held, is the point: "how many tagged boxes are in this area."
  List<Widget> _sweepList(AppController c, LocaleController loc) {
    if (_sweepTags.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 4),
          child: Text(
              loc.t('ยังไม่พบกล่อง — เหนี่ยวไกกวาดเหนือบริเวณที่จะตรวจ'),
              style: TextStyle(fontSize: 13, color: C.faint, height: 1.4)),
        ),
      ];
    }
    return [
      Row(
        children: [
          Expanded(
            child: Text('${loc.t('พบ')} ${_sweepTags.length} ${loc.t('กล่อง')}',
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: C.muted)),
          ),
          GestureDetector(
            onTap: () => setState(() => _sweepTags.clear()),
            child: Text(loc.t('ล้างรายการ'),
                style: TextStyle(
                    fontSize: 12.5,
                    color: C.orange,
                    fontWeight: FontWeight.w600)),
          ),
        ],
      ),
      const SizedBox(height: 8),
      Container(
        decoration: BoxDecoration(
          color: C.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: C.border),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(_sweepTags.length, (i) {
            final tag = _sweepTags[i];
            final b = c.S?.box(tag);
            return InkWell(
              onTap: b == null ? null : () => _pick(c, b),
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  border: i == _sweepTags.length - 1
                      ? null
                      : Border(bottom: BorderSide(color: C.border)),
                ),
                child: Row(
                  children: [
                    Icon(Icons.nfc, size: 18, color: C.muted),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(tag,
                              style: const TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                  fontFamily: 'monospace')),
                          if (b != null)
                            Text(c.S!.typeName(b.type),
                                style: TextStyle(fontSize: 12, color: C.muted)),
                        ],
                      ),
                    ),
                    if (b != null)
                      Icon(Icons.chevron_right, size: 18, color: C.faint),
                  ],
                ),
              ),
            );
          }),
        ),
      ),
    ];
  }

  // ── Step 2: locate ────────────────────────────────────────────────────
  Widget _locateBody(AppController c, LocaleController loc) {
    final bottom = MediaQuery.of(context).padding.bottom;
    final b = _target!;
    final S = c.S!;
    final connected = _status.state == RfidState.connected;
    final level = _rssi == null ? 0.0 : _normalize(_rssi!);
    final found = _rssi != null && level > 0.75;

    final l = b.location;
    final locParts = <String>[];
    if (b.status == 'out') {
      locParts.add('${loc.t('ออกอยู่กับ')} ${S.custName(b.customer)}');
    } else if (b.status == 'lost') {
      locParts.add(loc.t('แจ้งสูญหาย'));
    } else {
      locParts.add(S.whName(l['wh']?.toString()));
      if ((l['zone'] ?? '').toString().isNotEmpty)
        locParts.add('${loc.t('โซน')} ${l['zone']}');
      if ((l['rack'] ?? '').toString().isNotEmpty) locParts.add('${l['rack']}');
    }

    return ListView(
      padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
      children: [
        Panel(
          padding: const EdgeInsets.all(16),
          radius: 18,
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                    color: C.neutralBg2,
                    borderRadius: BorderRadius.circular(13)),
                child:
                    Icon(Icons.inventory_2_outlined, size: 24, color: C.ink2),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(b.tag,
                        style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w700,
                            fontFamily: 'monospace')),
                    Text('${S.typeName(b.type)} · ${locParts.join(' · ')}',
                        style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              GestureDetector(
                onTap: () => _changeTarget(c),
                child: Text(loc.t('เปลี่ยนกล่อง'),
                    style: TextStyle(
                        fontSize: 12.5,
                        color: C.ink2,
                        fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Panel(
          padding: const EdgeInsets.symmetric(vertical: 26, horizontal: 18),
          radius: 20,
          child: Column(
            children: [
              Row(
                children: [
                  Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: connected
                          ? C.lime
                          : (_status.state == RfidState.connecting
                              ? C.orange
                              : C.red),
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      !c.rfid.supported
                          ? loc.t('ใช้ได้เฉพาะบนเครื่องอ่าน Zebra')
                          : connected
                              ? loc.t(_reading
                                  ? 'กำลังกวาดหา…'
                                  : 'พร้อม — กดหรือเหนี่ยวไกเพื่อเริ่ม')
                              : _status.state == RfidState.connecting
                                  ? loc.t('กำลังเชื่อมต่อ…')
                                  : (_status.message.isEmpty
                                      ? loc.t('ยังไม่ได้เชื่อมต่อ')
                                      : _status.message),
                      style: const TextStyle(
                          fontSize: 13, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 22),
              _Gauge(level: level, found: found),
              const SizedBox(height: 18),
              Text(
                _rssi == null
                    ? loc.t('ไม่พบสัญญาณ')
                    : found
                        ? loc.t('พบกล่องแล้ว — อยู่ใกล้มาก')
                        : loc.t(_proximityLabel(level)),
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: _rssi == null
                      ? C.faint
                      : found
                          ? C.limeText
                          : C.ink,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _rssi == null
                    ? loc.t(
                        'เหนี่ยวไกแล้วเดินกวาดไปเรื่อยๆ สัญญาณจะแรงขึ้นเมื่อเข้าใกล้')
                    : 'RSSI ${_rssi}dBm · ${loc.t('อ่านพบแล้ว')} $_hits ${loc.t('ครั้ง')}',
                style: TextStyle(fontSize: 12, color: C.muted),
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: c.rfid.supported ? () => _toggleRead(c) : null,
                  icon: Icon(_reading ? Icons.stop : Icons.wifi_tethering),
                  label: Text(loc.t(_reading ? 'หยุดกวาด' : 'เริ่มกวาดหา')),
                  style: FilledButton.styleFrom(
                    backgroundColor: _reading ? C.red : C.ink,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          decoration: BoxDecoration(
            color: C.neutralBg,
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: C.border),
          ),
          child: Text(
            '${loc.t('ระบบบันทึกตำแหน่งล่าสุดว่า')} "${locParts.join(' · ')}" ${loc.t('— ใช้เป็นจุดเริ่มเดินกวาด '
                'แล้วสังเกตมิเตอร์ด้านบนเพื่อยืนยันว่ากล่องอยู่ในโซนนี้จริง')}',
            style: TextStyle(fontSize: 12, color: C.ink3, height: 1.45),
          ),
        ),
      ],
    );
  }

  String _proximityLabel(double level) {
    if (level > 0.55) return 'ใกล้แล้ว — เดินตามสัญญาณต่อ';
    if (level > 0.25) return 'กำลังมาถูกทาง';
    return 'ยังไกล — ลองเดินไปทางอื่น';
  }

  Widget _inputModeToggle(AppController c, LocaleController loc) {
    return ScanModeToggle(
      onChanged: (m) {
        setState(() {
          _sweepTags.clear();
          _scanError = null;
        });
      },
    );
  }
}

/// Signal-strength colour ramp for the Geiger sweep: grey (nothing) →
/// amber (something, keep walking) → green (it's right here). Deliberately
/// NOT the red→green ramp this used to run: red reads as "error/failure" in
/// every other part of this app, and a weak-but-valid signal is neither.
/// Grey→amber→green is the convention a signal meter actually wants —
/// absence, then partial, then good.
Color _signalColor(double level) {
  const grey = Color(0xFF9A9AA0);
  const amber = Color(0xFFF5A623);
  const green = Color(0xFF1E8E3E);
  if (level <= 0.0) return grey;
  if (level < 0.5) return Color.lerp(grey, amber, level / 0.5)!;
  return Color.lerp(amber, green, (level - 0.5) / 0.5)!;
}

/// Semi-circular signal meter with a large 0-100% readout in the middle —
/// the number is what an operator glancing down mid-walk actually reads,
/// the arc is what they track without reading. dBm never appears here: it's
/// a negative logarithmic figure that means nothing to anyone who isn't an
/// RF engineer (the raw value is still shown as small text below the gauge
/// for diagnostics).
class _Gauge extends StatelessWidget {
  final double level; // 0..1
  final bool found;
  const _Gauge({required this.level, required this.found});

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: level),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
      builder: (context, animated, _) => SizedBox(
        width: 240,
        height: 140,
        child: Stack(
          alignment: Alignment.bottomCenter,
          children: [
            CustomPaint(
              size: const Size(240, 140),
              painter: _GaugePainter(level: animated, found: found),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '${(animated * 100).round()}',
                    style: TextStyle(
                      fontSize: 44,
                      fontWeight: FontWeight.w800,
                      height: 1.0,
                      letterSpacing: -1.5,
                      color: animated <= 0 ? C.faint : _signalColor(animated),
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                  Text('%',
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: C.muted,
                          height: 1.1)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GaugePainter extends CustomPainter {
  final double level;
  final bool found;
  _GaugePainter({required this.level, required this.found});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height);
    final radius = size.width / 2 - 12;

    final track = Paint()
      ..color = C.neutralBg2
      ..style = PaintingStyle.stroke
      ..strokeWidth = 20
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(Rect.fromCircle(center: center, radius: radius), math.pi,
        math.pi, false, track);

    final clamped = level.clamp(0.0, 1.0);
    if (clamped > 0) {
      final fill = Paint()
        ..color = _signalColor(clamped)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 20
        ..strokeCap = StrokeCap.round;
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        math.pi,
        math.pi * clamped,
        false,
        fill,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _GaugePainter old) =>
      old.level != level || old.found != found;
}
