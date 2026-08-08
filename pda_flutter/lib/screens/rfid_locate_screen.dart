import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

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
  final _searchCtrl = TextEditingController();
  final _focus = FocusNode();

  _Step _step = _Step.pick;
  Box? _target;

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
  static const _rssiFar = -70;
  static const _rssiClose = -30;
  static const _staleAfter = Duration(milliseconds: 900);

  @override
  void initState() {
    super.initState();
    final rfid = context.read<AppController>().rfid;
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
    _decayTimer = Timer.periodic(const Duration(milliseconds: 200), (_) => _tick());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _focus.requestFocus();
      _forceMaxRangeAndNotify();
    });
  }

  /// Every time this screen is opened: push the reader's transmit power to
  /// its own max (a sweep search needs every bit of range it can get,
  /// regardless of whatever ใกล้/ปานกลาง/ไกล pick Settings last saved) and
  /// tell the operator it happened — "ทุกครั้ง" per the ask, not just the
  /// first visit, since the setting could have been dialed back again since.
  Future<void> _forceMaxRangeAndNotify() async {
    final c = context.read<AppController>();
    if (c.rfid.supported) {
      final d = await c.rfid.diagnostics();
      final maxIdx = d['powerMaxIndex'];
      if (maxIdx is int) {
        c.prefs.rfidPowerPercent = 100;
        await c.rfid.setPowerIndex(maxIdx);
      }
    }
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('ตั้งระยะยิงสูงสุด'),
        content: const Text('ระบบตั้งกำลังส่งสัญญาณของเครื่องอ่านไว้ที่ระยะไกลสุดโดยอัตโนมัติ '
            'เพื่อให้กวาดหากล่องได้ไกลที่สุดเท่าที่เครื่องรองรับ'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('เข้าใจแล้ว')),
        ],
      ),
    );
  }

  @override
  void dispose() {
    // Clear rather than leave dangling: a stray system-back press after
    // this screen is gone must not invoke a closure that calls setState on
    // an unmounted State.
    final c = context.read<AppController>();
    if (identical(c.systemBackOverride, _handleBack)) c.systemBackOverride = null;
    _tagSub?.cancel();
    _statusSub?.cancel();
    _triggerSub?.cancel();
    _decayTimer?.cancel();
    _searchCtrl.dispose();
    _focus.dispose();
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
    if ((wantEpc == null || wantEpc.isEmpty) && (wantTid == null || wantTid.isEmpty)) return;

    int? best;
    for (final r in batch) {
      final epc = r.epc.toUpperCase();
      final tid = r.tid?.toUpperCase();
      final isMatch = (wantEpc != null && wantEpc.isNotEmpty && epc == wantEpc) ||
          (wantTid != null && wantTid.isNotEmpty && tid == wantTid);
      if (!isMatch) continue;
      final rssi = r.rssi ?? _rssiClose; // no RSSI field on this read: treat as a direct hit
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
    if (_lastGradeSoundAt == null || now.difference(_lastGradeSoundAt!) >= soundGap) {
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

  /// RFID-mode picking: a trigger pull on the pick step resolves straight to
  /// a box the same way Track's scan-to-lookup does (AppController.
  /// resolveTag already matches by rfidEpc/rfidTid, not just the barcode
  /// key) — first box with a tag on file that answers wins.
  void _onPickBatch(List<RfidTagRead> batch) {
    final c = context.read<AppController>();
    if (c.scanInputMode != ScanInputMode.rfid) return;
    final s = c.S;
    if (s == null) return;
    for (final r in batch) {
      final tag = c.resolveTag(r.epc);
      final b = s.box(tag);
      if (b == null) continue;
      final hasTag = (b.rfidEpc?.isNotEmpty ?? false) || (b.rfidTid?.isNotEmpty ?? false);
      if (!hasTag) continue;
      _pick(c, b);
      return;
    }
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
    c.setScanInputMode(ScanInputMode.rfid);
  }

  void _changeTarget(AppController c) {
    c.rfid.stopInventory();
    setState(() {
      _step = _Step.pick;
      _target = null;
      _reading = false;
      _searchCtrl.clear();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    // Kept in sync every rebuild rather than only in initState/step
    // transitions — cheap, and guarantees a system back press always
    // matches whatever the StickyHeader arrow below would do right now.
    c.systemBackOverride = _step == _Step.locate ? _handleBack : null;
    return Column(
      children: [
        StickyHeader(
          onBack: _step == _Step.locate ? () => _changeTarget(c) : c.backToHome,
          title: const Text('หากล่อง / RFID'),
          subtitle: Text(_step == _Step.pick ? 'เลือกกล่องที่จะหา' : 'กวาดหาสัญญาณ'),
        ),
        Expanded(
          child: _step == _Step.pick ? _pickBody(c) : _locateBody(c),
        ),
      ],
    );
  }

  // ── Step 1: pick ──────────────────────────────────────────────────────
  Widget _pickBody(AppController c) {
    final bottom = MediaQuery.of(context).padding.bottom;
    final q = _searchCtrl.text.trim().toLowerCase();
    final all = c.S?.boxes.toList() ?? const <Box>[];
    final results = q.isEmpty
        ? const <Box>[]
        : all.where((b) {
            final type = c.S!.typeName(b.type).toLowerCase();
            return b.tag.toLowerCase().contains(q) || type.contains(q);
          }).take(30).toList();

    return ListView(
      padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
      children: [
        _inputModeToggle(c),
        const SizedBox(height: 11),
        if (c.scanInputMode == ScanInputMode.barcode)
          TextField(
            controller: _searchCtrl,
            focusNode: _focus,
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            enableSuggestions: false,
            onChanged: (_) => setState(() {}),
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
            decoration: InputDecoration(
              hintText: 'พิมพ์หรือยิงรหัสกล่อง เช่น CRT-01',
              hintStyle: TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 15),
              prefixIcon: Icon(Icons.search, color: C.muted),
              isDense: true,
              filled: true,
              fillColor: C.surface,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: BorderSide(color: C.ink, width: 1.5),
              ),
            ),
          )
        else
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 22),
            decoration: BoxDecoration(
              color: C.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: C.fieldBorder, width: 1.5),
            ),
            child: Column(
              children: [
                Icon(Icons.wifi_tethering, size: 22, color: C.muted),
                const SizedBox(height: 6),
                Text('เหนี่ยวไกยิงแท็กของกล่องที่จะหา',
                    style: TextStyle(fontSize: 13, color: C.muted, fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        const SizedBox(height: 14),
        if (c.scanInputMode != ScanInputMode.barcode)
          const SizedBox.shrink()
        else if (q.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 4),
            child: Text('พิมพ์รหัสหรือประเภทกล่อง เพื่อค้นหากล่องที่จะตามหา',
                style: TextStyle(fontSize: 13, color: C.faint, height: 1.4)),
          )
        else if (results.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 4),
            child: Text('ไม่พบกล่องที่ตรงกับ "$q"',
                style: TextStyle(fontSize: 13.5, color: C.red, fontWeight: FontWeight.w600)),
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
              children: List.generate(results.length, (i) {
                final b = results[i];
                final hasTag = (b.rfidEpc?.isNotEmpty ?? false) || (b.rfidTid?.isNotEmpty ?? false);
                final sm = StatusMeta.of(b.status);
                return InkWell(
                  onTap: hasTag ? () => _pick(c, b) : null,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      border: i == results.length - 1 ? null : Border(bottom: BorderSide(color: C.border)),
                    ),
                    child: Row(
                      children: [
                        Icon(hasTag ? Icons.nfc : Icons.nfc_outlined, size: 18, color: hasTag ? C.muted : C.faint),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(b.tag,
                                  style: const TextStyle(
                                      fontSize: 15, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                              Text(
                                hasTag ? c.S!.typeName(b.type) : '${c.S!.typeName(b.type)} · ยังไม่ได้ผูกแท็ก RFID',
                                style: TextStyle(fontSize: 12, color: hasTag ? C.muted : C.red),
                              ),
                            ],
                          ),
                        ),
                        Pill(sm.label, color: sm.color, bg: sm.bg, fontSize: 11),
                      ],
                    ),
                  ),
                );
              }),
            ),
          ),
      ],
    );
  }

  // ── Step 2: locate ────────────────────────────────────────────────────
  Widget _locateBody(AppController c) {
    final bottom = MediaQuery.of(context).padding.bottom;
    final b = _target!;
    final S = c.S!;
    final connected = _status.state == RfidState.connected;
    final level = _rssi == null ? 0.0 : _normalize(_rssi!);
    final found = _rssi != null && level > 0.75;

    final l = b.location;
    final locParts = <String>[];
    if (b.status == 'out') {
      locParts.add('ออกอยู่กับ ${S.custName(b.customer)}');
    } else if (b.status == 'lost') {
      locParts.add('แจ้งสูญหาย');
    } else {
      locParts.add(S.whName(l['wh']?.toString()));
      if ((l['zone'] ?? '').toString().isNotEmpty) locParts.add('โซน ${l['zone']}');
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
                decoration: BoxDecoration(color: C.neutralBg2, borderRadius: BorderRadius.circular(13)),
                child: Icon(Icons.inventory_2_outlined, size: 24, color: C.ink2),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(b.tag,
                        style: const TextStyle(
                            fontSize: 17, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                    Text('${S.typeName(b.type)} · ${locParts.join(' · ')}',
                        style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              GestureDetector(
                onTap: () => _changeTarget(c),
                child: Text('เปลี่ยนกล่อง', style: TextStyle(fontSize: 12.5, color: C.ink2, fontWeight: FontWeight.w600)),
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
                      color: connected ? C.lime : (_status.state == RfidState.connecting ? C.orange : C.red),
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      !c.rfid.supported
                          ? 'ใช้ได้เฉพาะบนเครื่องอ่าน Zebra'
                          : connected
                              ? (_reading ? 'กำลังกวาดหา…' : 'พร้อม — กดหรือเหนี่ยวไกเพื่อเริ่ม')
                              : _status.state == RfidState.connecting
                                  ? 'กำลังเชื่อมต่อ…'
                                  : (_status.message.isEmpty ? 'ยังไม่ได้เชื่อมต่อ' : _status.message),
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 22),
              _Gauge(level: level, found: found),
              const SizedBox(height: 18),
              Text(
                _rssi == null ? 'ไม่พบสัญญาณ' : found ? 'พบกล่องแล้ว — อยู่ใกล้มาก' : _proximityLabel(level),
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: _rssi == null ? C.faint : found ? C.limeText : C.ink,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _rssi == null ? 'เหนี่ยวไกแล้วเดินกวาดไปเรื่อยๆ สัญญาณจะแรงขึ้นเมื่อเข้าใกล้' : 'RSSI ${_rssi}dBm · อ่านพบแล้ว $_hits ครั้ง',
                style: TextStyle(fontSize: 12, color: C.muted),
              ),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: c.rfid.supported ? () => _toggleRead(c) : null,
                  icon: Icon(_reading ? Icons.stop : Icons.wifi_tethering),
                  label: Text(_reading ? 'หยุดกวาด' : 'เริ่มกวาดหา'),
                  style: FilledButton.styleFrom(
                    backgroundColor: _reading ? C.red : C.ink,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
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
            'ระบบบันทึกตำแหน่งล่าสุดว่า "${locParts.join(' · ')}" — ใช้เป็นจุดเริ่มเดินกวาด '
            'แล้วสังเกตมิเตอร์ด้านบนเพื่อยืนยันว่ากล่องอยู่ในโซนนี้จริง',
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

  Widget _inputModeToggle(AppController c) {
    Widget seg(ScanInputMode m, String label, IconData icon) {
      final selected = c.scanInputMode == m;
      return Expanded(
        child: GestureDetector(
          onTap: () {
            if (c.scanInputMode == m) return;
            c.setScanInputMode(m);
            if (m == ScanInputMode.barcode) {
              WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
            } else {
              _focus.unfocus();
            }
          },
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 9),
            decoration: BoxDecoration(
              color: selected ? C.ink : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 15, color: selected ? C.surface : C.ink2),
                const SizedBox(width: 6),
                Text(label,
                    style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: selected ? C.surface : C.ink2)),
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: C.neutralBg2, borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          seg(ScanInputMode.barcode, 'บาร์โค้ด', Icons.qr_code_scanner),
          seg(ScanInputMode.rfid, 'RFID', Icons.wifi_tethering),
        ],
      ),
    );
  }
}

/// Semi-circular signal meter — a needle sweeping 0..180° reads more like
/// "how close" at a glance than a numeric dBm ever would, which is the point
/// of a Geiger-style search: the operator watches the meter, not a number,
/// while walking.
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
        width: 220,
        height: 120,
        child: CustomPaint(
          painter: _GaugePainter(level: animated, found: found),
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
    final radius = size.width / 2 - 10;

    final track = Paint()
      ..color = C.neutralBg2
      ..style = PaintingStyle.stroke
      ..strokeWidth = 16
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(Rect.fromCircle(center: center, radius: radius), math.pi, math.pi, false, track);

    final fillColor = found ? C.limeText : Color.lerp(C.red, C.limeText, level)!;
    final fill = Paint()
      ..color = fillColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 16
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      math.pi,
      math.pi * level.clamp(0.0, 1.0),
      false,
      fill,
    );

    // Needle
    final angle = math.pi + math.pi * level.clamp(0.0, 1.0);
    final needleEnd = Offset(center.dx + radius * 0.82 * math.cos(angle), center.dy + radius * 0.82 * math.sin(angle));
    final needle = Paint()
      ..color = C.ink
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(center, needleEnd, needle);
    canvas.drawCircle(center, 6, Paint()..color = C.ink);
  }

  @override
  bool shouldRepaint(covariant _GaugePainter old) => old.level != level || old.found != found;
}
