import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// "ผูก Tag / ชำรุด / อื่นๆ" — the sixth primary-menu slot, for the
/// floor actions that don't each need their own button: commissioning an
/// RFID tag, intaking a brand-new box, and looking a box up by code/status
/// (Track). There's no standalone "แจ้งชำรุด" action here on purpose — the
/// backend has no endpoint to flag a box damaged outside of the Gate In
/// queue's own per-box condition picker (see scan_screen.dart's
/// _ConditionPicker), so that's called out below rather than faked with a
/// button that goes nowhere.
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
                    color: C.limeDeep,
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
                const SizedBox(height: 16),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: C.orangeBg,
                    borderRadius: BorderRadius.circular(13),
                    border: Border.all(color: C.orangeBorder),
                  ),
                  child: Text(
                    loc.t(
                        'แจ้งกล่องชำรุด — ทำได้ตอนรับเข้า (Gate In): ติ๊กสถานะ "ชำรุด" ที่การ์ดกล่องนั้นในคิวก่อนยืนยัน'),
                    style: TextStyle(
                        fontSize: 12,
                        color: C.orange,
                        height: 1.45,
                        fontWeight: FontWeight.w600),
                  ),
                ),
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
