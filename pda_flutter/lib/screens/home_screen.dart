import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final top = MediaQuery.of(context).padding.top;
    final bottom = MediaQuery.of(context).padding.bottom;

    return Column(
      children: [
        // header
        Padding(
          padding: EdgeInsets.fromLTRB(18, top + 14, 18, 6),
          child: Row(
            children: [
              const BrandMark(size: 40),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(c.user,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: -0.3)),
                    Text('${c.selWhName} · ประตู ${c.gate}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              OnlineChip(online: c.online, onTap: c.toggleOnline),
              const SizedBox(width: 8),
              RoundIconButton(icon: Icons.settings_outlined, onTap: () => c.go(Screen.settings), size: 38),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(18, 14, 18, bottom + 20),
            children: [
              if (!c.connected)
                Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 12),
                    decoration: BoxDecoration(
                      color: C.orangeBg,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: C.orangeBorder),
                    ),
                    child: const Text(
                      'ยังไม่ได้เชื่อมข้อมูลกับระบบหลัก — ไปที่ตั้งค่าเพื่อเชื่อมต่อ หรือใส่ข้อมูลตัวอย่าง',
                      style: TextStyle(fontSize: 12.5, color: C.orange, fontWeight: FontWeight.w600, height: 1.45),
                    ),
                  ),
                ),
              // stats
              Row(
                children: [
                  Expanded(child: _Stat(value: '${c.warehouseCount}', label: 'ในคลัง')),
                  const SizedBox(width: 9),
                  Expanded(child: _Stat(value: '${c.outCount}', label: 'ออกอยู่', valueColor: C.orange)),
                  const SizedBox(width: 9),
                  Expanded(child: _TodayStat(inN: c.todayIn, outN: c.todayOut)),
                ],
              ),
              const SizedBox(height: 16),
              const Caption('งานหลัก'),
              const SizedBox(height: 10),
              _ActionCard(
                dark: true,
                icon: Icons.south,
                iconColor: C.lime,
                iconBg: Colors.white.withOpacity(0.12),
                title: 'รับเข้า / รับคืน',
                sub: 'Gate In — ยิงกล่องกลับเข้าคลัง',
                onTap: c.goScanIn,
              ),
              const SizedBox(height: 12),
              _ActionCard(
                icon: Icons.north,
                iconColor: C.orange,
                iconBg: C.orangeBg,
                title: 'ส่งออก',
                sub: 'Gate Out — จ่ายกล่องออกให้ลูกค้า',
                onTap: c.goScanOut,
              ),
              const SizedBox(height: 12),
              _ActionCard(
                small: true,
                icon: Icons.search,
                iconColor: C.ink2,
                iconBg: C.neutralBg,
                title: 'ค้นหา / ตรวจสอบกล่อง',
                sub: 'Track — ดูสถานะ ตำแหน่ง ประวัติ',
                onTap: c.goTrack,
              ),
              if (c.outbox.isNotEmpty) ...[
                const SizedBox(height: 14),
                _OutboxBanner(count: c.outbox.length, onSync: c.toggleOnline),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  final String value, label;
  final Color? valueColor;
  const _Stat({required this.value, required this.label, this.valueColor});
  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(value,
              style: TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.6,
                  color: valueColor ?? C.ink,
                  fontFeatures: const [FontFeature.tabularFigures()])),
          Text(label, style: const TextStyle(fontSize: 11, color: C.muted, fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }
}

class _TodayStat extends StatelessWidget {
  final int inN, outN;
  const _TodayStat({required this.inN, required this.outN});
  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(height: 5),
          const Text('วันนี้', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: C.ink2, height: 1.35)),
          Text('↓$inN · ↑$outN', style: const TextStyle(fontSize: 13, color: C.muted, fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }
}

class _ActionCard extends StatelessWidget {
  final bool dark, small;
  final IconData icon;
  final Color iconColor, iconBg;
  final String title, sub;
  final VoidCallback onTap;
  const _ActionCard({
    this.dark = false,
    this.small = false,
    required this.icon,
    required this.iconColor,
    required this.iconBg,
    required this.title,
    required this.sub,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    final radius = small ? 20.0 : 22.0;
    final pad = small ? const EdgeInsets.symmetric(horizontal: 18, vertical: 16) : const EdgeInsets.all(18);
    final box = small ? 44.0 : 52.0;
    return Material(
      color: dark ? C.ink : C.surface,
      borderRadius: BorderRadius.circular(radius),
      child: InkWell(
        borderRadius: BorderRadius.circular(radius),
        onTap: onTap,
        child: Container(
          padding: pad,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radius),
            border: dark ? null : Border.all(color: C.border),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withOpacity(dark ? 0.14 : 0.06),
                blurRadius: dark ? 24 : (small ? 0 : 20),
                offset: Offset(0, dark ? 8 : 6),
              )
            ],
          ),
          child: Row(
            children: [
              Container(
                width: box,
                height: box,
                decoration: BoxDecoration(color: iconBg, borderRadius: BorderRadius.circular(box * 0.29)),
                child: Icon(icon, color: iconColor, size: small ? 23 : 27),
              ),
              const SizedBox(width: 15),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title,
                        style: TextStyle(
                            fontSize: small ? 16.5 : 19,
                            fontWeight: FontWeight.w700,
                            color: dark ? Colors.white : C.ink)),
                    Text(sub,
                        style: TextStyle(
                            fontSize: small ? 12.5 : 13,
                            color: dark ? Colors.white.withOpacity(0.62) : C.muted)),
                  ],
                ),
              ),
              Icon(Icons.chevron_right,
                  color: dark ? Colors.white.withOpacity(0.5) : C.chevron, size: small ? 20 : 22),
            ],
          ),
        ),
      ),
    );
  }
}

class _OutboxBanner extends StatelessWidget {
  final int count;
  final VoidCallback onSync;
  const _OutboxBanner({required this.count, required this.onSync});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
      decoration: BoxDecoration(
        color: C.neutralBg,
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: C.border2),
      ),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(color: C.orange, borderRadius: BorderRadius.circular(10)),
            alignment: Alignment.center,
            child: Text('$count',
                style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                    fontSize: 14,
                    fontFeatures: [FontFeature.tabularFigures()])),
          ),
          const SizedBox(width: 11),
          const Expanded(
            child: Text('รายการค้าง sync (ออฟไลน์) — จะส่งเข้าระบบเมื่อกลับมาออนไลน์',
                style: TextStyle(fontSize: 12.5, color: C.ink3, height: 1.4, fontWeight: FontWeight.w500)),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: onSync,
            style: FilledButton.styleFrom(
              backgroundColor: C.ink,
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              minimumSize: Size.zero,
            ),
            child: const Text('Sync', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}
