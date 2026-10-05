import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_prompt_card.dart';

class TrackScreen extends StatefulWidget {
  const TrackScreen({super.key});
  @override
  State<TrackScreen> createState() => _TrackScreenState();
}

class _TrackScreenState extends State<TrackScreen> {
  final _ctrl = TextEditingController();
  final _focus = FocusNode();
  bool _showAllHistory = false;

  /// The code field stays hidden until the operator taps พิมพ์รหัสกล่อง —
  /// opening this screen must not steal focus or raise the keyboard.
  bool _showTypeField = false;

  /// Typing already filters live (see trackSuggestions). Enter still
  /// resolves immediately when a scanner's trailing keystroke (or the
  /// keyboard's Go/Done) sends it; this debounce is the fallback for
  /// scanners on this terminal that don't send that trailing Enter.
  Timer? _autoSearchTimer;
  static const _autoSearchDelay = Duration(milliseconds: 180);
  static const _autoSearchMinLen = 3;
  static const _historyPreview = 3;
  static const _searchBlue = ScanPromptCard.actionBlue;

  /// Length after the previous onChanged — same trick login_screen.dart's
  /// badge field uses. A keyboard-wedge scan on this hardware often lands as
  /// one onChanged burst carrying the whole code rather than a keystroke at
  /// a time; more than one new character in a single callback is scan-speed
  /// proof no human typing produces, so that's committed immediately instead
  /// of waiting out [_autoSearchDelay]. That's what keeps two barcodes fired
  /// back-to-back from concatenating: the field clears the instant the first
  /// burst lands, before the second one can arrive on top of it.
  int _prevLen = 0;

  void _revealTypeField() {
    if (!_showTypeField) setState(() => _showTypeField = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
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
    final addedChars = _ctrl.text.length - _prevLen;
    _prevLen = _ctrl.text.length;
    if (text.isEmpty) return;
    if (text.length < _autoSearchMinLen) return;
    if (addedChars > 1) {
      c.doTrack();
      return;
    }
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
    final loc = context.watch<LocaleController>();
    // keep the field in sync when a hardware read populates trackVal — and
    // just as importantly, clear it back out once doTrack() empties trackVal
    // after a completed scan resolves (see AppController.doTrack); without
    // this half, the field kept showing the just-committed code and the next
    // scan's characters landed after it instead of into a clean field.
    if (c.trackVal.isNotEmpty && _ctrl.text != c.trackVal) {
      _ctrl.text = c.trackVal;
      _ctrl.selection = TextSelection.collapsed(offset: _ctrl.text.length);
    } else if (c.trackVal.isEmpty && _ctrl.text.isNotEmpty) {
      _ctrl.clear();
    }
    final bottom = MediaQuery.of(context).padding.bottom;
    final box = c.trackBox;
    final hits = c.scanInputMode == ScanInputMode.rfid
        ? c.trackRfidHits
        : c.trackBarcodeHits;
    final hitsUnit =
        c.scanInputMode == ScanInputMode.rfid ? loc.t('แท็ก') : loc.t('กล่อง');
    final hitsIcon = c.scanInputMode == ScanInputMode.rfid
        ? Icons.nfc
        : Icons.qr_code_scanner;

    final history = c.recentScanHistory;
    final historyShown =
        _showAllHistory ? history : history.take(_historyPreview).toList();
    final barcode = c.scanInputMode == ScanInputMode.barcode;

    return AutoHideHeader(
      header: StickyHeader(
        onBack: c.backToHome,
        title: Text(loc.t('ค้นหา / ตรวจสอบกล่อง')),
        subtitle: Text(loc.t('ยิงหรือพิมพ์รหัสกล่อง')),
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
              children: [
                if (c.hasIntegratedRfid) ...[
                  _inputModeToggle(c, loc),
                  const SizedBox(height: 12),
                ],
                _scanPromptCard(c, loc),
                if (barcode) ...[
                  const SizedBox(height: 16),
                  _orDivider(loc),
                  const SizedBox(height: 16),
                  _typeCodeButton(loc),
                  if (_showTypeField) ...[
                    const SizedBox(height: 12),
                    _searchField(c, loc),
                    const SizedBox(height: 12),
                    _searchButton(c, loc),
                  ],
                ],
                const SizedBox(height: 18),
                if (hits.isNotEmpty) ...[
                  _sectionHead(
                    '${loc.t('พบ')} ${hits.length} $hitsUnit',
                    action: loc.t('ล้าง'),
                    onAction: c.clearTrackHits,
                  ),
                  _hitsList(c, hits, hitsIcon, loc),
                  if (box != null) const SizedBox(height: 14),
                ] else if (box == null && c.trackSuggestions.isNotEmpty) ...[
                  _sectionHead(
                      '${loc.t('พบ')} ${c.trackSuggestions.length} ${loc.t('กล่อง')}'),
                  _suggestions(c, loc),
                ] else if (c.trackTried && box == null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                        vertical: 24, horizontal: 16),
                    child: Center(
                      child: Text(
                          '${loc.t('ไม่พบกล่อง')} "${c.trackVal}" ${loc.t('ในระบบ')}',
                          style: TextStyle(
                              fontSize: 13.5,
                              color: C.red,
                              fontWeight: FontWeight.w600)),
                    ),
                  ),
                if (box != null) _card(c, box, loc),
                if (box == null &&
                    c.trackSuggestions.isEmpty &&
                    hits.isEmpty &&
                    history.isNotEmpty) ...[
                  _sectionHead(
                    loc.t('ประวัติการสแกนล่าสุด'),
                    icon: Icons.schedule,
                    action: history.length > _historyPreview
                        ? loc.t(_showAllHistory ? 'ย่อ' : 'ดูทั้งหมด')
                        : null,
                    onAction: history.length > _historyPreview
                        ? () =>
                            setState(() => _showAllHistory = !_showAllHistory)
                        : null,
                  ),
                  _historyList(c, historyShown, loc),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _scanPromptCard(AppController c, LocaleController loc) {
    final rfid = c.scanInputMode == ScanInputMode.rfid;
    return ScanPromptCard(
      icon: rfid ? Icons.wifi_tethering : Icons.qr_code_2,
      title: loc.t(
          rfid ? 'เหนี่ยวไกเพื่ออ่านแท็ก RFID' : 'กดปุ่ม SCANNER ที่เครื่อง'),
      subtitle: rfid ? null : loc.t('เพื่อยิงบาร์โค้ดได้'),
    );
  }

  Widget _orDivider(LocaleController loc) {
    return Row(
      children: [
        Expanded(child: Divider(color: C.border2, height: 1)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(loc.t('หรือ'),
              style: TextStyle(fontSize: 13, color: C.muted)),
        ),
        Expanded(child: Divider(color: C.border2, height: 1)),
      ],
    );
  }

  Widget _typeCodeButton(LocaleController loc) {
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: _revealTypeField,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: C.border2),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.keyboard_alt_outlined, size: 20, color: C.ink2),
              const SizedBox(width: 8),
              Text(loc.t('พิมพ์รหัสกล่อง'),
                  style: const TextStyle(
                      fontSize: 15, fontWeight: FontWeight.w700)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _searchField(AppController c, LocaleController loc) {
    return TextField(
      controller: _ctrl,
      focusNode: _focus,
      textCapitalization: TextCapitalization.characters,
      autocorrect: false,
      enableSuggestions: false,
      onChanged: (_) => _onChanged(c),
      onSubmitted: (_) => _search(c),
      style: const TextStyle(
          fontSize: 16, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
      decoration: InputDecoration(
        hintText: loc.t('รหัสกล่อง เช่น CRT-01'),
        hintStyle:
            TextStyle(fontFamily: 'Roboto', color: C.faint, fontSize: 15),
        suffixIcon: _ctrl.text.isEmpty
            ? null
            : IconButton(
                icon: Icon(Icons.cancel, size: 20, color: C.faint),
                onPressed: () {
                  _ctrl.clear();
                  _prevLen = 0;
                  c.onTrackChanged('');
                },
              ),
        isDense: true,
        filled: true,
        fillColor: C.surface,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: BorderSide(color: C.fieldBorder, width: 1.5),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(color: _searchBlue, width: 1.5),
        ),
      ),
    );
  }

  Widget _searchButton(AppController c, LocaleController loc) {
    return SizedBox(
      width: double.infinity,
      child: Material(
        color: _searchBlue,
        borderRadius: BorderRadius.circular(18),
        child: InkWell(
          onTap: () => _search(c),
          borderRadius: BorderRadius.circular(18),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 15),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.search, size: 20, color: Colors.white),
                const SizedBox(width: 8),
                Text(loc.t('ค้นหา'),
                    style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: Colors.white)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _sectionHead(String title,
      {IconData? icon, String? action, VoidCallback? onAction}) {
    return Padding(
      padding: const EdgeInsets.only(left: 2, bottom: 10, top: 4),
      child: Row(
        children: [
          if (icon != null)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Icon(icon, size: 16, color: C.muted),
            ),
          Expanded(
            child: Text(title,
                style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                    color: C.ink2)),
          ),
          if (action != null && onAction != null)
            GestureDetector(
              onTap: onAction,
              child: Text('$action ›',
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: _searchBlue)),
            ),
        ],
      ),
    );
  }

  Widget _inputModeToggle(AppController c, LocaleController loc) {
    return ScanModeToggle(
      onChanged: (m) {
        if (m == ScanInputMode.barcode) {
          WidgetsBinding.instance
              .addPostFrameCallback((_) => _focus.requestFocus());
        } else {
          _focus.unfocus();
          // Finding boxes in a pile needs every bit of range the reader has,
          // regardless of whatever ใกล้/ปานกลาง/ไกล pick Settings last saved.
          c.forceMaxRfidPower();
        }
      },
    );
  }

  Widget _suggestions(AppController c, LocaleController loc) {
    return _boxRows(
      c,
      loc,
      c.trackSuggestions.map((tag) => c.S?.box(tag)).whereType<Box>().toList(),
      onTap: (b) => _tapSuggestion(c, b.tag),
    );
  }

  Widget _historyList(AppController c, List<Box> boxes, LocaleController loc) {
    return _boxRows(c, loc, boxes, onTap: (b) => c.viewTrackHit(b.tag));
  }

  Widget _boxRows(AppController c, LocaleController loc, List<Box> boxes,
      {required ValueChanged<Box> onTap}) {
    return Container(
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: C.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: List.generate(boxes.length, (i) {
          final b = boxes[i];
          return InkWell(
            onTap: () => onTap(b),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
              decoration: BoxDecoration(
                border: i == boxes.length - 1
                    ? null
                    : Border(bottom: BorderSide(color: C.border)),
              ),
              child: Row(
                children: [
                  Icon(Icons.inventory_2_outlined, size: 22, color: C.ink2),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(b.tag,
                        style: const TextStyle(
                            fontSize: 15.5,
                            fontWeight: FontWeight.w700,
                            fontFamily: 'monospace')),
                  ),
                  _statusChip(b.status, loc),
                  const SizedBox(width: 10),
                  Text(c.fmtTsThai(b.lastSeenAt),
                      style: TextStyle(fontSize: 11.5, color: C.muted)),
                ],
              ),
            ),
          );
        }),
      ),
    );
  }

  Widget _statusChip(String status, LocaleController loc) {
    final inWh = status == 'warehouse';
    final out = status == 'out';
    final label = inWh
        ? loc.t('ในคลัง')
        : out
            ? loc.t('นอกคลัง')
            : StatusMeta.of(status).label;
    final color = inWh
        ? const Color(0xFF16A34A)
        : out
            ? C.orange
            : StatusMeta.of(status).color;
    final bg = inWh
        ? const Color(0xFFDCFCE7)
        : out
            ? C.orangeBg
            : StatusMeta.of(status).bg;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration:
          BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
      child: Text(label,
          style: TextStyle(
              fontSize: 11, fontWeight: FontWeight.w700, color: color)),
    );
  }

  /// Vertical list of every distinct box found this session — RFID sweep
  /// hits (AppController.trackRfidHits) or committed barcode scans
  /// (trackBarcodeHits), whichever the current input mode is using — one row
  /// per tag, in the order it was first seen, tap a row to open its full
  /// detail card below.
  Widget _hitsList(
      AppController c, List<String> tags, IconData icon, LocaleController loc) {
    final S = c.S;
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
                border: i == tags.length - 1
                    ? null
                    : Border(bottom: BorderSide(color: C.border)),
              ),
              child: Row(
                children: [
                  Icon(icon, size: 18, color: C.muted),
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
                          Text(S!.typeName(b.type),
                              style: TextStyle(fontSize: 12, color: C.muted))
                        else
                          Text(loc.t('ไม่พบกล่องนี้ในระบบ'),
                              style: TextStyle(fontSize: 12, color: C.red)),
                      ],
                    ),
                  ),
                  if (sm != null)
                    Pill(sm.label, color: sm.color, bg: sm.bg, fontSize: 11),
                ],
              ),
            ),
          );
        }),
      ),
    );
  }

  Widget _card(AppController c, Box b, LocaleController loc) {
    final S = c.S!;
    final sm = StatusMeta.of(b.status);
    String line1Label, line1;
    if (b.status == 'out') {
      line1Label = loc.t('ลูกค้า / DO');
      line1 =
          '${S.custName(b.customer)}${b.doNo.isNotEmpty ? ' · ${b.doNo}' : ''}';
    } else if (b.status == 'lost') {
      line1Label = loc.t('สูญหายกับ');
      line1 = S.custName(b.customer);
    } else {
      final l = b.location;
      final parts = <String>[S.whName(l['wh']?.toString())];
      if ((l['zone'] ?? '').toString().isNotEmpty) {
        parts.add('${loc.t('โซน')} ${l['zone']}');
      }
      if ((l['rack'] ?? '').toString().isNotEmpty) parts.add('${l['rack']}');
      line1Label = loc.t('ตำแหน่ง');
      line1 = (l['zone'] != null || l['rack'] != null) && parts.length > 1
          ? parts.join(' · ')
          : '${S.whName(l['wh']?.toString())} · ${loc.t('รอจัดเก็บ')}';
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
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.06),
              blurRadius: 20,
              offset: const Offset(0, 6))
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // header
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: C.neutralBg2))),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                      color: C.neutralBg2,
                      borderRadius: BorderRadius.circular(15)),
                  child:
                      Icon(Icons.inventory_2_outlined, size: 28, color: C.ink2),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(b.tag,
                          style: const TextStyle(
                              fontSize: 21,
                              fontWeight: FontWeight.w700,
                              fontFamily: 'monospace',
                              letterSpacing: 0.4)),
                      Text(S.typeName(b.type),
                          style: TextStyle(fontSize: 13, color: C.muted)),
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
                _row(loc.t('รอบหมุนเวียน'), '${b.cycles} ${loc.t('รอบ')}'),
                const SizedBox(height: 11),
                _row(loc.t('เห็นล่าสุด'), c.fmtTs(b.lastSeenAt)),
              ],
            ),
          ),
          if (hist.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 4, 18, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 6, bottom: 12),
                    child: Caption(loc.t('ประวัติล่าสุด')),
                  ),
                  ...List.generate(hist.length, (i) {
                    final h = hist[i];
                    final dir = h['dir']?.toString();
                    final isInit = dir == 'in' &&
                        (h['note'] ?? '')
                            .toString()
                            .startsWith('รับเข้าครั้งแรก');
                    String title;
                    if (dir == 'out') {
                      title =
                          '${loc.t('ออก')} → ${S.custName(h['customer']?.toString())}';
                    } else if (isInit) {
                      title =
                          '${loc.t('รับเข้าครั้งแรก')} ${S.whName(h['wh']?.toString())}';
                    } else if (dir == 'in') {
                      title =
                          '${loc.t('รับคืนเข้า')} ${S.whName(h['wh']?.toString())}';
                    } else if (dir == 'lost') {
                      title = loc.t('ตีเป็นสูญหาย');
                    } else if (dir == 'relocate') {
                      title = loc.t('ย้ายตำแหน่ง');
                    } else {
                      title = loc.t('ลงทะเบียน');
                    }
                    final meta = <String>[c.fmtTs(h['ts']?.toString())];
                    if ((h['recorder'] ?? '').toString().isNotEmpty) {
                      meta.add('${loc.t('โดย')} ${h['recorder']}');
                    }
                    if (dir == 'out' && (h['do'] ?? '').toString().isNotEmpty) {
                      meta.add('${h['do']}');
                    }
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
          constraints:
              BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.5),
          child: Text(value,
              textAlign: TextAlign.right,
              style:
                  const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
        ),
      ],
    );
  }

  Widget _histRow(
      {required Color color,
      required String title,
      required String meta,
      required bool last}) {
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
                Expanded(
                    child: Container(
                        width: 2,
                        color: C.border,
                        margin: const EdgeInsets.only(top: 2))),
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
                  Text(title,
                      style: const TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                          height: 1.3)),
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
