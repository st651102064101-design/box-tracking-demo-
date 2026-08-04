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
              // The operator's name is the most important thing on this screen:
              // if the wrong person is signed in, it has to be noticeable
              // before a scan is committed — and fixable in one tap.
              Expanded(
                child: InkWell(
                  borderRadius: BorderRadius.circular(10),
                  onTap: () => _openHandover(context, c),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Text(c.user,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                      fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: -0.3)),
                            ),
                            const SizedBox(width: 4),
                            Icon(Icons.expand_more, size: 17, color: C.chevron),
                          ],
                        ),
                        Text(
                            c.postConfirmed
                                ? '${c.selWhName} · ประตู ${c.gate}${_gateDirSuffix(c.currentGateType)}'
                                : 'ยังไม่ได้เลือกคลัง/ประตู',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 12, color: C.muted)),
                      ],
                    ),
                  ),
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
                    child: Text(
                      'ยังไม่ได้เชื่อมข้อมูลกับระบบหลัก — ไปที่ตั้งค่าเพื่อเชื่อมต่อ หรือใส่ข้อมูลตัวอย่าง',
                      style: TextStyle(fontSize: 12.5, color: C.orange, fontWeight: FontWeight.w600, height: 1.45),
                    ),
                  ),
                ),
              ...(c.postConfirmed ? _confirmedBody(c) : _postPickerBody(c)),
            ],
          ),
        ),
      ],
    );
  }
}

/// รอยิงบัตรแล้ว แต่ยังไม่ได้ยืนยันคลัง/ประตูของรอบทำงานนี้ — "งานหลัก" ยังไม่โผล่
/// จนกว่าจะเลือกคลังแล้วเลือกประตูให้ครบ (ดู [AppController.selectPendingWh] /
/// [AppController.confirmPost])
List<Widget> _postPickerBody(AppController c) {
  final whs = c.warehouseList;
  if (whs.isEmpty) {
    return [
      const SizedBox(height: 16),
      _Note('ยังไม่มีคลังในระบบ — ไปเพิ่มคลังที่ระบบหลักก่อน'),
    ];
  }
  final pendingWh = c.pendingWh;
  if (pendingWh == null) {
    final showLast = c.hasLastSelection && whs.any((w) => (w['id'] ?? '').toString() == c.lastWh);
    return [
      const SizedBox(height: 16),
      const Caption('เลือกคลัง'),
      const SizedBox(height: 10),
      if (showLast) ...[
        _WhPickTile(
          name: '${c.lastWhName} · ประตู ${c.lastGate}',
          tag: 'ล่าสุด',
          icon: Icons.history,
          onTap: c.useLastPost,
        ),
        const SizedBox(height: 9),
      ],
      ...whs.map((w) {
        final id = (w['id'] ?? '').toString();
        return Padding(
          padding: const EdgeInsets.only(bottom: 9),
          child: _WhPickTile(
            name: (w['name'] ?? id).toString(),
            onTap: () => c.selectPendingWh(id),
          ),
        );
      }),
    ];
  }
  final gates = c.S?.gatesOf(pendingWh) ?? const [];
  final whName = c.S?.whName(pendingWh) ?? pendingWh;
  final gateTypes = c.S?.gateTypesOf(pendingWh) ?? const {};
  return [
    const SizedBox(height: 16),
    Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(child: Caption('เลือกประตู · $whName')),
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: c.clearPendingWh,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Text('เปลี่ยนคลัง',
                style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w600)),
          ),
        ),
      ],
    ),
    const SizedBox(height: 10),
    Wrap(
      spacing: 9,
      runSpacing: 9,
      children: gates
          .map((g) => _GatePickChip(
                label: '$g',
                dir: gateTypes['$g'] ?? 'both',
                onTap: () => c.confirmPost(pendingWh, g),
              ))
          .toList(),
    ),
  ];
}

/// คลัง/ประตูยืนยันแล้ว — สถิติ + "งานหลัก" ตามปกติ
List<Widget> _confirmedBody(AppController c) {
  return [
    Row(
      children: [
        Expanded(child: _Stat(value: '${c.warehouseCount}', label: 'ในคลัง')),
        const SizedBox(width: 9),
        Expanded(child: _Stat(value: '${c.outCount}', label: 'ออกอยู่', valueColor: C.orange)),
        const SizedBox(width: 9),
        Expanded(child: _TodayStat(inN: c.todayIn, outN: c.todayOut)),
      ],
    ),
    if (c.emp != null && c.isVisiting(c.emp!))
      Padding(
        padding: const EdgeInsets.only(top: 14),
        child: _Note('คุณประจำ ${c.S?.whName(c.emp!.wh) ?? c.emp!.wh} '
            '— รายการที่ยิงจะบันทึกที่ ${c.selWhName} ประตู ${c.gate}'),
      ),
    if (!c.canScan)
      Padding(
        padding: const EdgeInsets.only(top: 14),
        child: _Note('บัญชีนี้เป็นสิทธิ์ผู้ชม — ค้นหากล่องได้ แต่บันทึกเข้า/ออกไม่ได้'),
      ),
    const SizedBox(height: 16),
    const Caption('งานหลัก'),
    const SizedBox(height: 10),
    // ประตูที่ตั้งเป็น IN หรือ OUT อย่างเดียว (ไม่ใช่ both) แสดงได้แค่เมนูที่ตรงทิศทาง
    // ของประตูนั้น — กันไม่ให้ยิงกล่องออกจากประตูที่ตั้งไว้เป็นทางเข้าอย่างเดียว (หรือกลับกัน)
    if (c.canScan && c.currentGateType != 'out') ...[
      _ActionCard(
        dark: true,
        icon: Icons.south,
        iconColor: C.lime,
        iconBg: C.onInk.withValues(alpha: 0.12),
        title: 'รับเข้า / รับคืน',
        sub: 'Gate In — ยิงกล่องกลับเข้าคลัง',
        onTap: c.goScanIn,
      ),
      const SizedBox(height: 12),
    ],
    if (c.canScan && c.currentGateType != 'in') ...[
      _ActionCard(
        icon: Icons.north,
        iconColor: C.orange,
        iconBg: C.orangeBg,
        title: 'ส่งออก',
        sub: 'Gate Out — จ่ายกล่องออกให้ลูกค้า',
        onTap: c.goScanOut,
      ),
      const SizedBox(height: 12),
    ],
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
  ];
}

/// Handover sheet: end this person's session, or hand the device to the next
/// one. Both do the same thing — return to the badge screen — because a
/// handover *is* the sign-out. The device itself stays signed in and stationed
/// where it is, so the next operator is one badge scan away from working.
void _openHandover(BuildContext context, AppController c) {
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (sheetCtx) => Container(
      margin: const EdgeInsets.all(12),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(color: C.surface, borderRadius: BorderRadius.circular(22)),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(c.user, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          Text(
            [c.emp?.subtitle ?? '', '${c.selWhName} · ประตู ${c.gate}']
                .where((s) => s.isNotEmpty)
                .join(' · '),
            style: TextStyle(fontSize: 12.5, color: C.muted),
          ),
          const SizedBox(height: 16),
          _SheetAction(
            icon: Icons.swap_horiz,
            label: 'เปลี่ยนคน / จบงาน',
            sub: 'กลับไปหน้ายิงบัตร — เครื่องยังประจำประตูเดิม',
            onTap: () {
              Navigator.of(sheetCtx).pop();
              c.lock();
            },
          ),
          if (c.canScan) ...[
            const SizedBox(height: 10),
            _SheetAction(
              icon: Icons.sync_alt,
              label: 'เปลี่ยนคลัง/ประตู',
              sub: 'เลือกจุดทำงานใหม่สำหรับกะนี้',
              onTap: () {
                Navigator.of(sheetCtx).pop();
                c.reselectPost();
              },
            ),
          ],
          if (c.canConfigureDevice) ...[
            const SizedBox(height: 10),
            _SheetAction(
              icon: Icons.settings_outlined,
              label: 'ตั้งค่าเครื่อง',
              sub: 'เปลี่ยนคลัง/ประตูที่เครื่องนี้ประจำ',
              onTap: () {
                Navigator.of(sheetCtx).pop();
                c.goDeviceSetup();
              },
            ),
          ],
        ],
      ),
    ),
  );
}

class _WhPickTile extends StatelessWidget {
  final String name;
  final VoidCallback onTap;
  final String? tag;
  final IconData? icon;
  const _WhPickTile({required this.name, required this.onTap, this.tag, this.icon});
  @override
  Widget build(BuildContext context) {
    final highlighted = tag != null;
    return Material(
      color: highlighted ? C.ink : C.neutralBg,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
          child: Row(
            children: [
              if (icon != null) ...[
                Icon(icon, size: 19, color: highlighted ? C.lime : C.ink2),
                const SizedBox(width: 11),
              ],
              Expanded(
                child: Text(name,
                    style: TextStyle(
                        fontSize: 15.5,
                        fontWeight: FontWeight.w600,
                        color: highlighted ? C.onInk : null)),
              ),
              if (tag != null) ...[
                Pill(tag!, color: C.lime, bg: C.onInk.withValues(alpha: 0.14)),
                const SizedBox(width: 8),
              ],
              Icon(Icons.chevron_right, size: 20, color: highlighted ? C.onInk.withValues(alpha: 0.5) : C.chevron),
            ],
          ),
        ),
      ),
    );
  }
}

class _GatePickChip extends StatelessWidget {
  final String label;
  final String dir; // 'in' | 'out' | 'both'
  final VoidCallback onTap;
  const _GatePickChip({required this.label, required this.dir, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.neutralBg,
      borderRadius: BorderRadius.circular(13),
      child: InkWell(
        borderRadius: BorderRadius.circular(13),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minWidth: 64),
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 11),
          alignment: Alignment.center,
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(13), border: Border.all(color: C.border2)),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('ประตู $label',
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              Text(_gateDirLabel(dir),
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                    color: dir == 'out' ? C.orange : (dir == 'in' ? C.lime : C.muted),
                  )),
            ],
          ),
        ),
      ),
    );
  }
}

/// Always names a direction, unlike [_gateDirSuffix] (which leaves 'both'
/// blank for the header line) — the whole point here is to make a gate
/// picked from a list say up front whether it's inbound-only, outbound-only,
/// or both, so an operator can't confirm the wrong one by accident.
String _gateDirLabel(String dir) {
  switch (dir) {
    case 'in':
      return 'ขาเข้า';
    case 'out':
      return 'ขาออก';
    default:
      return 'ขาเข้า และ ขาออก';
  }
}

class _SheetAction extends StatelessWidget {
  final IconData icon;
  final String label, sub;
  final VoidCallback onTap;
  const _SheetAction({required this.icon, required this.label, required this.sub, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.neutralBg,
      borderRadius: BorderRadius.circular(15),
      child: InkWell(
        borderRadius: BorderRadius.circular(15),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          child: Row(
            children: [
              Icon(icon, size: 21, color: C.ink2),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    Text(sub, style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Neutral inline note — context the operator should see but not act on.
class _Note extends StatelessWidget {
  final String text;
  const _Note(this.text);
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: C.neutralBg,
          borderRadius: BorderRadius.circular(13),
          border: Border.all(color: C.border),
        ),
        child: Text(text, style: TextStyle(fontSize: 12.5, color: C.ink3, height: 1.4)),
      );
}

String _gateDirSuffix(String dir) {
  switch (dir) {
    case 'in':
      return ' (เข้า)';
    case 'out':
      return ' (ออก)';
    default:
      return '';
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
          Text(label, style: TextStyle(fontSize: 11, color: C.muted, fontWeight: FontWeight.w500)),
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
          Text('วันนี้', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: C.ink2, height: 1.35)),
          Text('↓$inN · ↑$outN', style: TextStyle(fontSize: 13, color: C.muted, fontWeight: FontWeight.w500)),
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
                            color: dark ? C.onInk : C.ink)),
                    Text(sub,
                        style: TextStyle(
                            fontSize: small ? 12.5 : 13,
                            color: dark ? C.onInk.withValues(alpha: 0.62) : C.muted)),
                  ],
                ),
              ),
              Icon(Icons.chevron_right,
                  color: dark ? C.onInk.withValues(alpha: 0.5) : C.chevron, size: small ? 20 : 22),
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
                style: TextStyle(
                    color: C.onInk,
                    fontWeight: FontWeight.w700,
                    fontSize: 14,
                    fontFeatures: [FontFeature.tabularFigures()])),
          ),
          const SizedBox(width: 11),
          Expanded(
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
