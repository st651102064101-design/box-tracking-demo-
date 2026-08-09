import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// "ผูก Tag / ชำรุด / อื่นๆ" — the sixth primary-menu slot, for the
/// floor actions that don't each need their own button on Home: commissioning
/// an RFID tag, intaking a brand-new box, looking a box up (Track),
/// holding/damaging/releasing a box already in the warehouse, the "ของหาย" /
/// "ช่องเก็บเต็ม" floor-exception reports, and the reverse "เช็คช่อง" location
/// lookup.
class MoreHubScreen extends StatelessWidget {
  const MoreHubScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;

    return AutoHideHeader(
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
                    icon: Icons.sell_outlined,
                    color: C.red,
                    bg: C.redBg,
                    title: loc.t('ผูกแท็ก RFID'),
                    sub: loc
                        .t('สแกนบาร์โค้ด แล้วยิงแท็กเพื่อผูกกับกล่องนั้นทันที'),
                    onTap: c.goRfidRegister,
                  ),
                  const SizedBox(height: 10),
                  _tile(
                    icon: Icons.add_box_outlined,
                    // limeDeep is a fixed near-black green — fine as text on
                    // a bright C.lime button, but paired with limeBg (which
                    // *does* darken in dark mode) the two collapse into
                    // near-black-on-near-black. limeText is the token that
                    // actually inverts for dark mode.
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
                  icon: Icons.search,
                  color: C.ink2,
                  bg: C.neutralBg,
                  title: loc.t('ค้นหา / ตรวจสอบกล่อง'),
                  sub: loc.t('Track — ดูสถานะ ตำแหน่ง ประวัติ'),
                  onTap: c.goTrack,
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
                    icon: Icons.report_gmailerrorred_outlined,
                    color: C.red,
                    bg: C.redBg,
                    title: loc.t('แจ้งปัญหาหน้างาน'),
                    sub: loc.t('ของหาย / ช่องเก็บเต็ม / กล่องชำรุด / อ่านแท็กไม่ติด'),
                    onTap: c.goReportProblem,
                  ),
                  const SizedBox(height: 10),
                  _tile(
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
    );
  }

  Widget _tile({
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
              Icon(Icons.chevron_right, color: C.chevron, size: 22),
            ],
          ),
        ),
      ),
    );
  }
}
