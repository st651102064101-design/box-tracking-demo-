import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// "ผูก Tag / ชำรุด / อื่นๆ" — the second (and last) primary-menu slot, for
/// every floor action besides Gate In/Out: commissioning an RFID tag,
/// intaking a brand-new box, looking a box up (Track), ย้ายตำแหน่ง (Transfer),
/// ตรวจนับ (Cycle Count), ค้นหา/เรดาร์ (RFID Locate), the "ของหาย" /
/// "ช่องเก็บเต็ม" / "กล่องชำรุด" / "อ่านแท็กไม่ติด" floor-exception reports, and
/// the reverse "เช็คช่อง" location lookup. Everything that isn't Gate In/Out
/// lives here now — Home used to spread ย้ายตำแหน่ง/ตรวจนับ/ค้นหาเรดาร์ across
/// three of its own tiles, which meant six similarly-weighted menu items
/// competing for attention instead of two.
class MoreHubScreen extends StatelessWidget {
  const MoreHubScreen({super.key});

  /// Same physical number-key convention as HomeScreen — matches the [1]-[8]
  /// badges each _tile shows below. Only the tiles c.canScan actually makes
  /// visible get a live key; the others do nothing rather than jump to a
  /// screen the operator can't act on anyway.
  static const _keyActions = <int, String>{
    1: 'rfidRegister',
    2: 'boxRegister',
    3: 'track',
    4: 'transfer',
    5: 'cycleCount',
    6: 'locate',
    7: 'reportProblem',
    8: 'locationInquiry',
  };

  KeyEventResult _onKey(AppController c, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final digit = _digitFor(event.logicalKey);
    if (digit == null) return KeyEventResult.ignored;
    final action = _keyActions[digit];
    if (action == null) return KeyEventResult.ignored;
    switch (action) {
      case 'rfidRegister':
        if (c.canScan) c.goRfidRegister();
        break;
      case 'boxRegister':
        if (c.canScan) c.goBoxRegister();
        break;
      case 'track':
        c.goTrack();
        break;
      case 'transfer':
        if (c.canScan) c.goTransfer();
        break;
      case 'cycleCount':
        c.goCycleCount();
        break;
      case 'locate':
        c.goLocate();
        break;
      case 'reportProblem':
        if (c.canScan) c.goReportProblem();
        break;
      case 'locationInquiry':
        if (c.canScan) c.goLocationInquiry();
        break;
    }
    return KeyEventResult.handled;
  }

  static final _topRow = {
    LogicalKeyboardKey.digit0: 0,
    LogicalKeyboardKey.digit1: 1,
    LogicalKeyboardKey.digit2: 2,
    LogicalKeyboardKey.digit3: 3,
    LogicalKeyboardKey.digit4: 4,
    LogicalKeyboardKey.digit5: 5,
    LogicalKeyboardKey.digit6: 6,
    LogicalKeyboardKey.digit7: 7,
    LogicalKeyboardKey.digit8: 8,
    LogicalKeyboardKey.digit9: 9,
  };
  static final _numpad = {
    LogicalKeyboardKey.numpad0: 0,
    LogicalKeyboardKey.numpad1: 1,
    LogicalKeyboardKey.numpad2: 2,
    LogicalKeyboardKey.numpad3: 3,
    LogicalKeyboardKey.numpad4: 4,
    LogicalKeyboardKey.numpad5: 5,
    LogicalKeyboardKey.numpad6: 6,
    LogicalKeyboardKey.numpad7: 7,
    LogicalKeyboardKey.numpad8: 8,
    LogicalKeyboardKey.numpad9: 9,
  };

  static int? _digitFor(LogicalKeyboardKey key) => _topRow[key] ?? _numpad[key];

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;

    return Focus(
      autofocus: true,
      onKeyEvent: (node, event) => _onKey(c, event),
      child: AutoHideHeader(
        header: StickyHeader(
          onBack: c.backToHome,
          title: Text(loc.t('ผูก Tag / ชำรุด / อื่นๆ')),
        ),
        body: Column(
          children: [
            Expanded(
              child: ListView(
                padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
                children: [
                  if (c.canScan) ...[
                    _tile(
                      number: 1,
                      icon: Icons.sell_outlined,
                      color: C.red,
                      bg: C.redBg,
                      title: loc.t('ผูกแท็ก RFID'),
                      sub: loc.t(
                          'สแกนบาร์โค้ด แล้วยิงแท็กเพื่อผูกกับกล่องนั้นทันที'),
                      onTap: c.goRfidRegister,
                    ),
                    const SizedBox(height: 10),
                    _tile(
                      number: 2,
                      icon: Icons.add_box_outlined,
                      // limeDeep is a fixed near-black green — fine as text
                      // on a bright C.lime button, but paired with limeBg
                      // (which *does* darken in dark mode) the two collapse
                      // into near-black-on-near-black. limeText is the token
                      // that actually inverts for dark mode.
                      color: C.limeText,
                      bg: C.limeBg,
                      title: loc.t('ลงทะเบียนกล่องใหม่'),
                      sub: loc.t(
                          'รับกล่องจาก supplier — สร้างกล่อง ติดป้าย ผูกแท็ก แล้ว Putaway'),
                      onTap: c.goBoxRegister,
                    ),
                    const SizedBox(height: 10),
                  ],
                  _tile(
                    number: 3,
                    icon: Icons.search,
                    color: C.ink2,
                    bg: C.neutralBg,
                    title: loc.t('ค้นหา / ตรวจสอบกล่อง'),
                    sub: loc.t('Track — ดูสถานะ ตำแหน่ง ประวัติ'),
                    onTap: c.goTrack,
                  ),
                  if (c.canScan) ...[
                    const SizedBox(height: 10),
                    _tile(
                      number: 4,
                      icon: Icons.sync_alt,
                      color: C.menuBlue,
                      bg: C.menuBlueBg,
                      title: loc.t('ย้ายตำแหน่ง'),
                      sub: 'Transfer',
                      onTap: c.goTransfer,
                    ),
                  ],
                  const SizedBox(height: 10),
                  _tile(
                    number: 5,
                    icon: Icons.checklist,
                    color: C.menuOrange,
                    bg: C.menuOrangeBg,
                    title: loc.t('ตรวจนับ'),
                    sub: 'Cycle Count',
                    onTap: c.goCycleCount,
                  ),
                  const SizedBox(height: 10),
                  _tile(
                    number: 6,
                    icon: Icons.radar,
                    color: C.menuOrange,
                    bg: C.menuOrangeBg,
                    title: loc.t('ค้นหา/เรดาร์'),
                    sub: 'Search / Radar',
                    onTap: c.goLocate,
                  ),
                  if (c.canScan) ...[
                    const SizedBox(height: 10),
                    // "พัก / แจ้งชำรุด" used to be its own tile here — it now
                    // lives as a reason inside "แจ้งปัญหาหน้างาน" (its
                    // "กล่องชำรุด" tile forwards straight into
                    // HoldReleaseScreen), so an operator has one place to
                    // start from for anything wrong with a box or a shelf,
                    // not two similarly-named tiles to choose between.
                    _tile(
                      number: 7,
                      icon: Icons.report_gmailerrorred_outlined,
                      color: C.red,
                      bg: C.redBg,
                      title: loc.t('แจ้งปัญหาหน้างาน'),
                      sub: loc
                          .t('ของหาย / ช่องเก็บเต็ม / กล่องชำรุด / อ่านแท็กไม่ติด'),
                      onTap: c.goReportProblem,
                    ),
                    const SizedBox(height: 10),
                    _tile(
                      number: 8,
                      icon: Icons.grid_view_outlined,
                      color: C.limeText,
                      bg: C.limeBg,
                      title: loc.t('เช็คช่อง'),
                      sub: loc.t('ยิงบาร์โค้ดชั้นวาง ดูว่าควรมีอะไรอยู่'),
                      onTap: c.goLocationInquiry,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _tile({
    required int number,
    required IconData icon,
    required Color color,
    required Color bg,
    required String title,
    required String sub,
    required VoidCallback onTap,
  }) {
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: C.border)),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                    color: bg, borderRadius: BorderRadius.circular(13)),
                child: Icon(icon, color: color, size: 25),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w700)),
                    Text(sub, style: TextStyle(fontSize: 12.5, color: C.muted)),
                  ],
                ),
              ),
              Container(
                width: 22,
                height: 22,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                    color: C.neutralBg, borderRadius: BorderRadius.circular(7)),
                child: Text('$number',
                    style: TextStyle(
                        fontSize: 11.5,
                        fontWeight: FontWeight.w800,
                        color: C.ink2,
                        fontFamily: 'monospace')),
              ),
              const SizedBox(width: 6),
              Icon(Icons.chevron_right, color: C.chevron, size: 22),
            ],
          ),
        ),
      ),
    );
  }
}
