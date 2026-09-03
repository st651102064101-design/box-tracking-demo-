import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/epc_codec.dart';
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

enum _Step { pick, locate, locateMulti }

class _RfidLocateScreenState extends State<RfidLocateScreen> {
  /// Set when a scanned code doesn't resolve to a taggable box — shown under
  /// the scan prompt until the next scan replaces or clears it.
  String? _scanError;

  _Step _step = _Step.pick;
  Box? _target;

  /// Narrows the pick-list to one product type at a time — null means "all
  /// types". A plain alphabetical-by-tag list of every tagged box in the
  /// warehouse has no way to jump to "the one I want" short of already
  /// knowing its exact tag; picking a type first (what an operator standing
  /// in the aisle actually knows) cuts that list down to something scannable
  /// at a glance.
  String? _typeFilter;

  /// "ค้นหาพร้อมกัน (Multi-Track)" — off by default (single box, today's
  /// flow). On, each scanned/tapped box is added to [_multiTargets] instead
  /// of jumping straight into the single-target gauge; "เริ่มค้นหา" then
  /// moves into [_Step.locateMulti], which shows one proximity bar per box
  /// instead of the one big gauge. There is no true bearing/angle here (see
  /// the module docstring) — this is the same signal-strength idea as the
  /// single-target gauge, just N of them side by side.
  bool _multiMode = false;
  final List<Box> _multiTargets = [];

  /// Per-target rolling signal state for the locateMulti step — same decay
  /// idea as the single-target [_rssi]/[_lastHitAt], keyed by tag so each
  /// bar decays independently instead of all sharing one clock.
  final Map<String, int?> _multiRssi = {};
  final Map<String, DateTime?> _multiLastHit = {};

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
    if (identical(c.systemBackOverride, _handleBack)) {
      c.systemBackOverride = null;
    }
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
    if (_step == _Step.pick) return; // barcode-only now — see [_onScan]
    if (_step == _Step.locateMulti) {
      _onMultiBatch(batch);
      return;
    }
    if (_target == null) return;
    // A read matches on whichever identifier the box is bound by — the
    // reader reports EPC (and sometimes TID) and `rfidCode` is compared to
    // both, since a box commissioned through the current endpoint stores
    // that value in `rfid`, not in the old EPC/TID pair. `want` is null for
    // a box with nothing bound via /api/boxes/:tag/rfid yet — that used to
    // bail out of this whole function before it even reached
    // epcMatchesTag(epc, wantTag) below, which is exactly the fallback path
    // for a tag that's physically on the box (its own barcode written in as
    // ASCII) but was never bound through the API. A box register/locate flow
    // that lets an unbound box be picked (see box_register_screen.dart) has
    // to actually sweep for it, not silently do nothing every batch.
    final want = _target!.rfidCode?.toUpperCase();
    final wantTag = _target!.tag.toUpperCase();

    int? best;
    for (final r in batch) {
      final epc = r.epc.toUpperCase();
      final tid = r.tid?.toUpperCase();
      // Also a hit when the EPC is this box's own barcode written as ASCII
      // (how tags are encoded here) — the same read the gate screens resolve
      // through AppController.resolveTag.
      final isMatch =
          (want != null && want.isNotEmpty && (epc == want || tid == want)) ||
              epcMatchesTag(epc, wantTag);
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

  /// Multi-track sweep: every batch read is checked against every box in
  /// [_multiTargets] (not just the strongest single match, like the
  /// single-target path above) — a held trigger over a pile can legitimately
  /// see several of the boxes being searched for in the same batch, and each
  /// one's bar has to move independently. Same haptic/audio grading as the
  /// single-target gauge, but driven off whichever target read strongest in
  /// this batch (a per-target buzz for every one of N boxes at once would
  /// just be noise), so the operator gets one aggregate "getting warmer"
  /// signal while still reading exact per-box status off the bars.
  void _onMultiBatch(List<RfidTagRead> batch) {
    if (_multiTargets.isEmpty) return;
    final now = DateTime.now();
    int? overallBest;
    var changed = false;
    for (final target in _multiTargets) {
      final want = target.rfidCode?.toUpperCase();
      final wantTag = target.tag.toUpperCase();
      // See _onBatch's comment above — a null/empty `want` (nothing bound
      // via the API yet) must still fall through to epcMatchesTag below,
      // not skip this target entirely.
      int? best;
      for (final r in batch) {
        final epc = r.epc.toUpperCase();
        final tid = r.tid?.toUpperCase();
        final isMatch = (want != null &&
                want.isNotEmpty &&
                (epc == want || tid == want)) ||
            epcMatchesTag(epc, wantTag);
        if (!isMatch) continue;
        final rssi = r.rssi ?? _rssiClose;
        if (best == null || rssi > best) best = rssi;
      }
      if (best == null) continue;
      _multiRssi[target.tag] = best;
      _multiLastHit[target.tag] = now;
      changed = true;
      if (overallBest == null || best > overallBest) overallBest = best;
    }
    if (!changed) return;
    setState(() {});

    final level = _normalize(overallBest!);
    final minGap = Duration(milliseconds: (260 - (level * 200)).round());
    if (_lastHapticAt == null || now.difference(_lastHapticAt!) >= minGap) {
      _lastHapticAt = now;
      if (level > 0.75) {
        HapticFeedback.mediumImpact();
      } else {
        HapticFeedback.selectionClick();
      }
    }
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

  /// Runs off a timer, not off reads, because "no read arrived" is itself the
  /// signal the meter has to show (falling back to zero) — a stream listener
  /// alone only ever fires when something *was* seen.
  void _tick() {
    if (_rssi != null &&
        _lastHitAt != null &&
        DateTime.now().difference(_lastHitAt!) > _staleAfter) {
      setState(() => _rssi = null);
    }
    if (_multiLastHit.isEmpty) return;
    final now = DateTime.now();
    var changed = false;
    for (final tag in _multiLastHit.keys.toList()) {
      final last = _multiLastHit[tag];
      if (last != null &&
          now.difference(last) > _staleAfter &&
          _multiRssi[tag] != null) {
        _multiRssi[tag] = null;
        changed = true;
      }
    }
    if (changed && mounted) setState(() {});
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
  /// step resolves a target now (no RFID toggle here anymore: this screen is
  /// find-by-scan only, see [_pickBody] and the module docstring). A picking
  /// ticket or an existing pallet label both carry a real, scannable code;
  /// typing one was the thing that let a mistyped tag jump straight into a
  /// sweep for the wrong box. In single mode this jumps straight into the
  /// sweep step on a match, same as tapping that box in the list below
  /// would; in [_multiMode] it's added to the running [_multiTargets] list
  /// instead so the next scan can add another box to the same search.
  void _onScan(AppController c, String raw) {
    final loc = context.read<LocaleController>();
    final s = c.S;
    if (s == null) return;
    final b = s.box(c.resolveTag(raw));
    if (b == null) {
      setState(() => _scanError = '${loc.t('ไม่พบกล่องรหัส')} "$raw"');
      return;
    }
    // No hard block for a box with no RFID mapped yet (removed — this used
    // to stop the operator right here with "ยังไม่ได้ผูกแท็ก RFID — หาไม่ได้",
    // framing it as an error to fix before they could even try). Any box
    // that resolves is pickable, same as Track/Transfer never special-case
    // RFID status either; _locateBody shows a plain notice instead once
    // inside the sweep step if there's genuinely nothing to match against
    // (see the box.hasRfid check there) — the entry point itself no longer
    // gates on it.
    setState(() => _scanError = null);
    if (_multiMode) {
      _addMultiTarget(b);
    } else {
      _pick(c, b);
    }
  }

  void _addMultiTarget(Box b) {
    if (_multiTargets.any((t) => t.tag == b.tag)) return;
    setState(() => _multiTargets.add(b));
  }

  void _removeMultiTarget(String tag) {
    setState(() {
      _multiTargets.removeWhere((t) => t.tag == tag);
      _multiRssi.remove(tag);
      _multiLastHit.remove(tag);
    });
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

  /// Moves from the pick step's scanned [_multiTargets] list into
  /// [_Step.locateMulti] — same rfidLocateSweepStep/scanInputMode wiring
  /// [_pick] uses for the single-target gauge, just with N bars instead of
  /// one.
  void _startMultiLocate(AppController c) {
    if (_multiTargets.isEmpty) return;
    setState(() {
      _step = _Step.locateMulti;
      _multiRssi.clear();
      _multiLastHit.clear();
      for (final t in _multiTargets) {
        _multiRssi[t.tag] = null;
        _multiLastHit[t.tag] = null;
      }
    });
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
      // Readings, not the picked list — coming back from locateMulti keeps
      // _multiTargets so the operator can add/remove a box and re-run
      // without re-scanning everything, but the stale gauge levels from the
      // last sweep have to go.
      _multiRssi.clear();
      _multiLastHit.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    // Kept in sync every rebuild rather than only in initState/step
    // transitions — cheap, and guarantees a system back press always
    // matches whatever the StickyHeader arrow below would do right now.
    //
    // Guarded on c.screen still being rfidLocate: RootScreen cross-fades
    // between the outgoing and incoming screen (AnimatedSwitcher), so both
    // stay mounted and both rebuild off the same notifyListeners() call that
    // navigates away — including this one, moments after backToHome()/
    // handleSystemBack() already moved c.screen elsewhere. Without this
    // guard, that stale rebuild re-asserts _handleBack right after the new
    // screen just cleared it, leaving systemBackOverride pointing at a
    // screen that's about to be disposed — the next back press then either
    // no-ops or throws calling into a defunct State, and the hardware/
    // gesture back control looks permanently dead from every screen until
    // the app restarts.
    if (c.screen == Screen.rfidLocate) {
      c.systemBackOverride =
          (_step == _Step.locate || _step == _Step.locateMulti)
              ? _handleBack
              : null;
    }
    return ScanCapture(
      // Live on the pick step only — locate/locateMulti are RFID-only by
      // definition and drive their own reader stream instead. No mode check
      // here anymore: the pick step no longer has an RFID toggle to be in.
      enabled: _step == _Step.pick,
      onScan: (raw) => _onScan(c, raw),
      child: AutoHideHeader(
        header: StickyHeader(
          onBack: _step != _Step.pick ? () => _changeTarget(c) : c.backToHome,
          title: Text(loc.t('หากล่อง / RFID')),
          subtitle: Text(loc.t(_step == _Step.pick
              ? 'ยิงบาร์โค้ดกล่องที่จะหา'
              : 'กวาดหาสัญญาณ')),
        ),
        body: Column(
          children: [
            Expanded(
              child: _step == _Step.pick
                  ? _pickBody(c, loc)
                  : _step == _Step.locate
                      ? _locateBody(c, loc)
                      : _locateMultiBody(c, loc),
            ),
          ],
        ),
      ),
    );
  }

  // ── Step 1: pick ──────────────────────────────────────────────────────
  Widget _pickBody(AppController c, LocaleController loc) {
    final bottom = MediaQuery.of(context).padding.bottom;
    // Every box, browsable without typing anything — this is what a
    // scan-only pick step falls back to when there's no picking ticket or
    // pallet label in hand to scan. Used to be filtered to b.hasRfid only
    // (a box with no RFID mapped yet couldn't even be picked here) — removed
    // per request: picking a box no longer requires it to already be
    // RFID-mapped, matching how Track/Transfer never gate on RFID status
    // either. A box with nothing to match against just won't move the meter
    // once inside the sweep step (see the notice in _locateBody).
    final allBoxes = (c.S?.boxes.toList() ?? const <Box>[])
      ..sort((a, b) => a.tag.compareTo(b.tag));

    // Distinct types actually present, by display name. '' stands in for
    // "no type set" so it can still be a normal map key.
    final typeNames = <String, String>{}; // type id -> display name
    for (final b in allBoxes) {
      final id = b.type ?? '';
      typeNames[id] = c.S!.typeName(b.type);
    }
    final typeIds = typeNames.keys.toList()
      ..sort((a, b) => typeNames[a]!.compareTo(typeNames[b]!));
    if (_typeFilter != null && !typeIds.contains(_typeFilter)) {
      _typeFilter = null; // the selected type's last box moved out
    }
    final tagged = _typeFilter == null
        ? allBoxes
        : allBoxes.where((b) => (b.type ?? '') == _typeFilter).toList();

    return ListView(
      padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
      children: [
        // "ค้นหาพร้อมกัน (Multi-Track)" — no RFID/barcode mode toggle here
        // anymore (this screen is find-by-scan only): the only choice left
        // on this step is whether one scan jumps straight to the gauge or
        // adds to a running multi-box list. See [_onScan]/[_addMultiTarget].
        InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => setState(() {
            _multiMode = !_multiMode;
            if (!_multiMode) {
              _multiTargets.clear();
              _multiRssi.clear();
              _multiLastHit.clear();
            }
          }),
          child: Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: _multiMode ? C.limeBg : C.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                  color: _multiMode ? C.limeBorder : C.fieldBorder,
                  width: 1.5),
            ),
            child: Row(
              children: [
                Icon(Icons.checklist_rtl,
                    size: 18, color: _multiMode ? C.limeText : C.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(loc.t('ค้นหาพร้อมกัน (Multi-Track)'),
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: _multiMode ? C.limeText : C.ink2)),
                ),
                Switch(
                  value: _multiMode,
                  onChanged: (v) => setState(() {
                    _multiMode = v;
                    if (!v) {
                      _multiTargets.clear();
                      _multiRssi.clear();
                      _multiLastHit.clear();
                    }
                  }),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 11),
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
                child: Text(
                    loc.t(_multiMode
                        ? 'ยิงบาร์โค้ดกล่องที่จะหา — ยิงได้หลายกล่อง'
                        : 'ยิงบาร์โค้ดกล่องที่จะหา'),
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
        const SizedBox(height: 14),
        if (_multiMode)
          ..._multiPickList(c, loc)
        else if (allBoxes.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 4),
            child: Text(loc.t('ยังไม่มีกล่องในระบบ'),
                style: TextStyle(fontSize: 13, color: C.faint, height: 1.4)),
          )
        else ...[
          Text(loc.t('หรือเลือกจากรายการ'),
              style: TextStyle(
                  fontSize: 12, fontWeight: FontWeight.w700, color: C.muted)),
          const SizedBox(height: 8),
          // Pick a product type first — cuts a warehouse-wide alphabetical
          // list down to something an operator standing in the aisle can
          // actually scan by eye, without needing to know a tag up front.
          if (typeIds.length > 1) ...[
            SizedBox(
              height: 34,
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: ChoiceChip(
                      label: Text(loc.t('ทั้งหมด')),
                      selected: _typeFilter == null,
                      onSelected: (_) => setState(() => _typeFilter = null),
                    ),
                  ),
                  for (final id in typeIds)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(typeNames[id]!),
                        selected: _typeFilter == id,
                        onSelected: (_) =>
                            setState(() => _typeFilter = id),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
          if (tagged.isEmpty)
            Padding(
              padding:
                  const EdgeInsets.symmetric(vertical: 20, horizontal: 4),
              child: Text(loc.t('ไม่มีกล่องประเภทนี้ในระบบ'),
                  style: TextStyle(fontSize: 13, color: C.faint, height: 1.4)),
            )
          else
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

  /// [_multiMode]'s running list of scanned targets — Empty state prompts
  /// for the first scan; non-empty shows every box queued for the search so
  /// far (each removable individually) plus the button that moves into
  /// [_Step.locateMulti] once there's at least one.
  List<Widget> _multiPickList(AppController c, LocaleController loc) {
    if (_multiTargets.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 4),
          child: Text(loc.t('ยังไม่มีกล่อง — ยิงบาร์โค้ดกล่องที่ต้องการหาทีละกล่อง'),
              style: TextStyle(fontSize: 13, color: C.faint, height: 1.4)),
        ),
      ];
    }
    return [
      Row(
        children: [
          Expanded(
            child: Text(
                '${loc.t('เลือกแล้ว')} ${_multiTargets.length} ${loc.t('กล่อง')}',
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: C.muted)),
          ),
          GestureDetector(
            onTap: () => setState(() {
              _multiTargets.clear();
              _multiRssi.clear();
              _multiLastHit.clear();
            }),
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
          children: List.generate(_multiTargets.length, (i) {
            final b = _multiTargets[i];
            return Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                border: i == _multiTargets.length - 1
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
                            style: TextStyle(fontSize: 12, color: C.muted)),
                      ],
                    ),
                  ),
                  IconButton(
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(),
                    onPressed: () => _removeMultiTarget(b.tag),
                    icon: Icon(Icons.close, size: 18, color: C.faint),
                  ),
                ],
              ),
            );
          }),
        ),
      ),
      const SizedBox(height: 14),
      SizedBox(
        width: double.infinity,
        child: FilledButton.icon(
          onPressed: () => _startMultiLocate(c),
          icon: const Icon(Icons.wifi_tethering),
          label:
              Text('${loc.t('เริ่มค้นหา')} (${_multiTargets.length})'),
          style: FilledButton.styleFrom(
            backgroundColor: C.ink,
            padding: const EdgeInsets.symmetric(vertical: 14),
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12)),
          ),
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
      if ((l['zone'] ?? '').toString().isNotEmpty) {
        locParts.add('${loc.t('โซน')} ${l['zone']}');
      }
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
        // Picking a box here no longer requires it to already have an RFID
        // tag mapped (see _pickBody/_onScan) — if it genuinely has none, say
        // so plainly instead of leaving the operator to wonder why the
        // meter never moves. box_register_screen.dart is the one place a
        // tag actually gets bound (see its own comment on why), so this is
        // a pointer there, not a binding action taken from this screen.
        if (!b.hasRfid) ...[
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: C.orangeBg,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: C.orangeBorder),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.info_outline, size: 18, color: C.orange),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    loc.t(
                        'กล่องนี้ยังไม่มีแท็ก RFID ผูกไว้ — เครื่องจะไม่มีสัญญาณให้กวาดหา ผูกแท็กได้ที่หน้า "ลงทะเบียนกล่อง"'),
                    style: TextStyle(fontSize: 12.5, color: C.orange, height: 1.4),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
        ],
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

  // ── Step 3: locateMulti — Proximity Heat-Bar per box ────────────────────
  /// The "Multi-RFID Radar" the design brief asked for, built the way the
  /// hardware actually supports it (see the module docstring on why there's
  /// no dot-on-a-map bearing here): one bar per box instead of one gauge for
  /// one box, walking a strength ramp grey → amber → green exactly like the
  /// single-target gauge, just N of them so "which of these boxes am I
  /// closest to" reads at a glance instead of one at a time.
  Widget _locateMultiBody(AppController c, LocaleController loc) {
    final bottom = MediaQuery.of(context).padding.bottom;
    final connected = _status.state == RfidState.connected;
    return ListView(
      padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
      children: [
        Panel(
          padding: const EdgeInsets.all(14),
          radius: 16,
          child: Row(
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
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
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
        ..._multiTargets.map((b) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _HeatBar(
                box: b,
                level: _multiRssi[b.tag] == null
                    ? 0.0
                    : _normalize(_multiRssi[b.tag]!),
                rssi: _multiRssi[b.tag],
                typeName: c.S!.typeName(b.type),
              ),
            )),
        const SizedBox(height: 10),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: c.rfid.supported ? () => _toggleRead(c) : null,
            icon: Icon(_reading ? Icons.stop : Icons.wifi_tethering),
            label: Text(loc.t(_reading ? 'หยุดกวาด' : 'เริ่มกวาดหา')),
            style: FilledButton.styleFrom(
              backgroundColor: _reading ? C.red : C.ink,
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape:
                  RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
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
            loc.t('เดินกวาดไปเรื่อยๆ — แถบของแต่ละกล่องจะสว่างขึ้นเมื่อเข้าใกล้กล่องนั้น '
                'พร้อมกันได้หลายกล่อง'),
            style: TextStyle(fontSize: 12, color: C.ink3, height: 1.45),
          ),
        ),
      ],
    );
  }
}

/// One row of [_locateMultiBody]'s Proximity Heat-Bar — a box's tag/type on
/// the left, a horizontal strength bar on the right using the same
/// grey→amber→green ramp and 0-100% readout the single-target [_Gauge]
/// uses, just laid out to stack N-high instead of taking the whole screen
/// for one box.
class _HeatBar extends StatelessWidget {
  final Box box;
  final double level; // 0..1
  final int? rssi;
  final String typeName;
  const _HeatBar(
      {required this.box,
      required this.level,
      required this.rssi,
      required this.typeName});

  @override
  Widget build(BuildContext context) {
    final found = rssi != null && level > 0.75;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: level),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
      builder: (context, animated, _) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: C.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
              color: found
                  ? C.limeBorder
                  : rssi != null
                      ? _signalColor(animated).withValues(alpha: 0.4)
                      : C.border),
        ),
        child: Row(
          children: [
            Expanded(
              flex: 3,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(box.tag,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          fontFamily: 'monospace')),
                  Text(typeName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, color: C.muted)),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 4,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: SizedBox(
                  height: 12,
                  child: Stack(
                    children: [
                      Container(color: C.neutralBg2),
                      FractionallySizedBox(
                        widthFactor: animated.clamp(0.0, 1.0),
                        child: Container(color: _signalColor(animated)),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            SizedBox(
              width: 40,
              child: Text(
                rssi == null ? '—' : '${(animated * 100).round()}%',
                textAlign: TextAlign.right,
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    color: rssi == null ? C.faint : _signalColor(animated)),
              ),
            ),
          ],
        ),
      ),
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
