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

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _search(AppController c) {
    c.onTrackChanged(_ctrl.text);
    c.doTrack();
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
              // search box
              TextField(
                controller: _ctrl,
                focusNode: _focus,
                textCapitalization: TextCapitalization.characters,
                autocorrect: false,
                enableSuggestions: false,
                onChanged: c.onTrackChanged,
                onSubmitted: (_) => _search(c),
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
                decoration: InputDecoration(
                  hintText: 'รหัสกล่อง เช่น CRT-01',
                  hintStyle: const TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 15),
                  prefixIcon: const Icon(Icons.search, color: C.muted),
                  suffixIcon: IconButton(
                    icon: const Icon(Icons.arrow_forward, color: Colors.white),
                    style: IconButton.styleFrom(
                        backgroundColor: C.ink, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
                    onPressed: () => _search(c),
                  ),
                  isDense: true,
                  filled: true,
                  fillColor: C.surface,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: const BorderSide(color: C.fieldBorder, width: 1.5),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: const BorderSide(color: C.fieldBorder, width: 1.5),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: const BorderSide(color: C.ink, width: 1.5),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              if (c.trackTried && box == null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
                  child: Center(
                    child: Text('ไม่พบกล่อง "${c.trackVal}" ในระบบ',
                        style: const TextStyle(fontSize: 13.5, color: C.red, fontWeight: FontWeight.w600)),
                  ),
                ),
              if (box != null) _card(c, box),
            ],
          ),
        ),
      ],
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
            decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: C.neutralBg2))),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(color: C.neutralBg2, borderRadius: BorderRadius.circular(15)),
                  child: const Icon(Icons.inventory_2_outlined, size: 28, color: C.ink2),
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
                      Text(S.typeName(b.type), style: const TextStyle(fontSize: 13, color: C.muted)),
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
        Text(label, style: const TextStyle(fontSize: 13.5, color: C.muted)),
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
                  Text(meta, style: const TextStyle(fontSize: 12, color: C.muted)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
