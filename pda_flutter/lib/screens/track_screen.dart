import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../theme.dart';
import '../widgets/common.dart';

class TrackScreen extends StatefulWidget {
  const TrackScreen({super.key});
  @override
  State<TrackScreen> createState() => _TrackScreenState();
}

class _TrackScreenState extends State<TrackScreen> {
  final _ctrl = TextEditingController();
  final _focus = FocusNode();

  /// No submit button — typing already filters live (see trackSuggestions),
  /// and a scan should never need a tap either. Enter still resolves
  /// immediately when a scanner's trailing keystroke (or the keyboard's
  /// Go/Done) sends it; this debounce is the fallback for scanners on this
  /// terminal that don't send that trailing Enter (see the same pattern in
  /// scan_screen.dart / rfid_register_screen.dart).
  Timer? _autoSearchTimer;
  static const _autoSearchDelay = Duration(milliseconds: 180);
  static const _autoSearchMinLen = 3;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _autoSearchTimer?.cancel();
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _search(AppController c) {
    _autoSearchTimer?.cancel();
    c.onTrackChanged(_ctrl.text);
    c.doTrack();
  }

  void _onChanged(AppController c) {
    c.onTrackChanged(_ctrl.text);
    _autoSearchTimer?.cancel();
    final text = _ctrl.text.trim();
    if (text.length < _autoSearchMinLen) return;
    _autoSearchTimer = Timer(_autoSearchDelay, () {
      if (!mounted || _ctrl.text.trim() != text) return;
      c.doTrack();
    });
  }

  void _tapSuggestion(AppController c, String tag) {
    _ctrl.text = tag;
    _ctrl.selection = TextSelection.collapsed(offset: tag.length);
    c.selectTrackSuggestion(tag);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    // keep the field in sync when a hardware read populates trackVal
    if (c.trackVal.isNotEmpty && _ctrl.text != c.trackVal) {
      _ctrl.text = c.trackVal;
      _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    }
    final bottom = MediaQuery.of(context).padding.bottom;
    final box = c.trackBox;

    return Column(
      children: [
        StickyHeader(
          onBack: c.backToHome,
          title: const Text('ค้นหา / ตรวจสอบกล่อง'),
          subtitle: const Text('ยิงหรือพิมพ์รหัสกล่อง'),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
            children: [
              _inputModeToggle(c),
              const SizedBox(height: 11),
              // search box — hidden entirely in RFID mode (see the toggle
              // above): nothing to type when the reader resolves the scan
              // directly through AppController._onReaderTag.
              if (c.scanInputMode == ScanInputMode.barcode)
                TextField(
                  controller: _ctrl,
                  focusNode: _focus,
                  textCapitalization: TextCapitalization.characters,
                  autocorrect: false,
                  enableSuggestions: false,
                  onChanged: (_) => _onChanged(c),
                  onSubmitted: (_) => _search(c),
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
                  decoration: InputDecoration(
                    hintText: 'รหัสกล่อง เช่น CRT-01',
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
                      Text('เหนี่ยวไกเพื่ออ่านแท็ก RFID',
                          style: TextStyle(fontSize: 13, color: C.muted, fontWeight: FontWeight.w600)),
                    ],
                  ),
                ),
              const SizedBox(height: 14),
              // Live suggestions as soon as the first character lands —
              // scanning still works the same (a gun sends the full code +
              // Enter in one burst, resolving straight to the card below),
              // this is purely for someone typing by hand who shouldn't have
              // to get the whole code exactly right before seeing anything.
              if (c.scanInputMode == ScanInputMode.rfid && c.trackRfidHits.isNotEmpty) ...[
                Padding(
                  padding: const EdgeInsets.only(left: 2, bottom: 8),
                  child: Text('พบ ${c.trackRfidHits.length} แท็ก',
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
                ),
                _rfidHitsList(c),
                if (box != null) const SizedBox(height: 14),
              ] else if (box == null && c.trackSuggestions.isNotEmpty) ...[
                Padding(
                  padding: const EdgeInsets.only(left: 2, bottom: 8),
                  child: Text('พบ ${c.trackSuggestions.length} กล่อง',
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: C.muted)),
                ),
                _suggestions(c),
              ] else if (c.trackTried && box == null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
                  child: Center(
                    child: Text('ไม่พบกล่อง "${c.trackVal}" ในระบบ',
                        style: TextStyle(fontSize: 13.5, color: C.red, fontWeight: FontWeight.w600)),
                  ),
                ),
              if (box != null) _card(c, box),
            ],
          ),
        ),
      ],
    );
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

  /// A search can genuinely match a hundred-plus boxes (see
  /// AppController.trackSuggestions, uncapped on purpose) — a vertical list
  /// of a hundred rows means a hundred rows of scrolling before the operator
  /// even sees whether their box is in there. A grid of small ID cards puts
  /// far more of the result set on screen at once; column count adapts to
  /// the available width but stays clamped 3-10 so cards on a wide screen
  /// don't shrink to unreadable and cards on a narrow one don't get crushed
  /// three-to-a-row when only three fit anyway.
  Widget _suggestions(AppController c) {
    final tags = c.trackSuggestions;
    final S = c.S;
    return LayoutBuilder(
      builder: (context, constraints) {
        final cols = (constraints.maxWidth / 92).floor().clamp(3, 10);
        return GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: tags.length,
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: cols,
            crossAxisSpacing: 8,
            mainAxisSpacing: 8,
            childAspectRatio: 0.86,
          ),
          itemBuilder: (context, i) {
            final tag = tags[i];
            final b = S?.box(tag);
            final sm = b != null ? StatusMeta.of(b.status) : null;
            return InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: () => _tapSuggestion(c, tag),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
                decoration: BoxDecoration(
                  color: C.surface,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: sm?.color.withValues(alpha: 0.35) ?? C.border),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.inventory_2_outlined, size: 17, color: C.muted),
                    const SizedBox(height: 6),
                    Text(tag,
                        textAlign: TextAlign.center,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 11.5, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                    if (sm != null) ...[
                      const SizedBox(height: 5),
                      Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(color: sm.color, shape: BoxShape.circle),
                      ),
                    ],
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  /// Vertical list of every distinct tag the reader has found this sweep
  /// (see AppController.trackRfidHits) — one row per tag, in the order it
  /// was first seen, tap a row to open its full detail card below.
  Widget _rfidHitsList(AppController c) {
    final S = c.S;
    final tags = c.trackRfidHits;
    return Container(
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: C.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: List.generate(tags.length, (i) {
          final tag = tags[i];
          final b = S?.box(tag);
          final sm = b != null ? StatusMeta.of(b.status) : null;
          final selected = c.trackTried && c.trackTag == tag;
          return InkWell(
            onTap: () => c.viewTrackHit(tag),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: selected ? C.neutralBg : null,
                border: i == tags.length - 1 ? null : Border(bottom: BorderSide(color: C.border)),
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
                                fontSize: 15, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                        if (b != null)
                          Text(S!.typeName(b.type), style: TextStyle(fontSize: 12, color: C.muted))
                        else
                          Text('ไม่พบกล่องนี้ในระบบ', style: TextStyle(fontSize: 12, color: C.red)),
                      ],
                    ),
                  ),
                  if (sm != null) Pill(sm.label, color: sm.color, bg: sm.bg, fontSize: 11),
                ],
              ),
            ),
          );
        }),
      ),
    );
  }

  Widget _card(AppController c, Box b) {
    final S = c.S!;
    final sm = StatusMeta.of(b.status);
    String line1Label, line1;
    if (b.status == 'out') {
      line1Label = 'ลูกค้า / DO';
      line1 = '${S.custName(b.customer)}${b.doNo.isNotEmpty ? ' · ${b.doNo}' : ''}';
    } else if (b.status == 'lost') {
      line1Label = 'สูญหายกับ';
      line1 = S.custName(b.customer);
    } else {
      final l = b.location;
      final parts = <String>[S.whName(l['wh']?.toString())];
      if ((l['zone'] ?? '').toString().isNotEmpty) parts.add('โซน ${l['zone']}');
      if ((l['rack'] ?? '').toString().isNotEmpty) parts.add('${l['rack']}');
      line1Label = 'ตำแหน่ง';
      line1 = (l['zone'] != null || l['rack'] != null) && parts.length > 1
          ? parts.join(' · ')
          : '${S.whName(l['wh']?.toString())} · รอจัดเก็บ';
    }

    final hist = b.history.reversed.take(6).toList();
    Color histColor(String? dir) {
      switch (dir) {
        case 'out':
          return C.orange;
        case 'in':
          return C.ink2;
        case 'lost':
          return C.red;
        case 'relocate':
          return C.ink2;
        default:
          return C.chevron;
      }
    }

    return Container(
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: C.border),
        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.06), blurRadius: 20, offset: const Offset(0, 6))],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // header
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: C.neutralBg2))),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(color: C.neutralBg2, borderRadius: BorderRadius.circular(15)),
                  child: Icon(Icons.inventory_2_outlined, size: 28, color: C.ink2),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(b.tag,
                          style: const TextStyle(
                              fontSize: 21, fontWeight: FontWeight.w700, fontFamily: 'monospace', letterSpacing: 0.4)),
                      Text(S.typeName(b.type), style: TextStyle(fontSize: 13, color: C.muted)),
                    ],
                  ),
                ),
                Pill(sm.label, color: sm.color, bg: sm.bg, fontSize: 12),
              ],
            ),
          ),
          // rows
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 15, 18, 11),
            child: Column(
              children: [
                _row(line1Label, line1),
                const SizedBox(height: 11),
                _row('รอบหมุนเวียน', '${b.cycles} รอบ'),
                const SizedBox(height: 11),
                _row('เห็นล่าสุด', c.fmtTs(b.lastSeenAt)),
              ],
            ),
          ),
          if (hist.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 4, 18, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.only(top: 6, bottom: 12),
                    child: Caption('ประวัติล่าสุด'),
                  ),
                  ...List.generate(hist.length, (i) {
                    final h = hist[i];
                    final dir = h['dir']?.toString();
                    final isInit = dir == 'in' && (h['note'] ?? '').toString().startsWith('รับเข้าครั้งแรก');
                    String title;
                    if (dir == 'out') {
                      title = 'ออก → ${S.custName(h['customer']?.toString())}';
                    } else if (isInit) {
                      title = 'รับเข้าครั้งแรก ${S.whName(h['wh']?.toString())}';
                    } else if (dir == 'in') {
                      title = 'รับคืนเข้า ${S.whName(h['wh']?.toString())}';
                    } else if (dir == 'lost') {
                      title = 'ตีเป็นสูญหาย';
                    } else if (dir == 'relocate') {
                      title = 'ย้ายตำแหน่ง';
                    } else {
                      title = 'ลงทะเบียน';
                    }
                    final meta = <String>[c.fmtTs(h['ts']?.toString())];
                    if ((h['recorder'] ?? '').toString().isNotEmpty) meta.add('โดย ${h['recorder']}');
                    if (dir == 'out' && (h['do'] ?? '').toString().isNotEmpty) meta.add('${h['do']}');
                    return _histRow(
                      color: histColor(dir),
                      title: title,
                      meta: meta.join(' · '),
                      last: i == hist.length - 1,
                    );
                  }),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _row(String label, String value) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 13.5, color: C.muted)),
        const Spacer(),
        ConstrainedBox(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.5),
          child: Text(value,
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
        ),
      ],
    );
  }

  Widget _histRow({required Color color, required String title, required String meta, required bool last}) {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
            children: [
              Container(
                width: 11,
                height: 11,
                margin: const EdgeInsets.only(top: 3),
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              if (!last)
                Expanded(child: Container(width: 2, color: C.border, margin: const EdgeInsets.only(top: 2))),
            ],
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 15),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, height: 1.3)),
                  Text(meta, style: TextStyle(fontSize: 12, color: C.muted)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
