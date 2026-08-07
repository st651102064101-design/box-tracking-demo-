import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
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
              // Reflects real, auto-detected server reachability everywhere
              // this chip appears (badge screen, here, Gate) — see
              // AppController.connected/retryOrConfigure.
              OnlineChip(online: c.connected, onTap: c.retryOrConfigure),
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
              ...(c.postConfirmed ? _confirmedBody(context, c) : _postPickerBody(c)),
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
                type: gateTypes['$g'] ?? 'both',
                onTap: () => c.confirmPost(pendingWh, g),
              ))
          .toList(),
    ),
  ];
}

/// คลัง/ประตูยืนยันแล้ว — สถิติ + "งานหลัก" ตามปกติ
List<Widget> _confirmedBody(BuildContext context, AppController c) {
  return [
    Row(
      children: [
        Expanded(
          child: _Stat(
            value: '${c.warehouseCount}',
            label: 'ในคลัง',
            onTap: () => _showBoxListSheet(context, c, title: 'กล่องในคลัง', status: 'warehouse'),
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: _Stat(
            value: '${c.outCount}',
            label: 'ออกอยู่',
            valueColor: C.orange,
            onTap: () => _showBoxListSheet(context, c, title: 'กล่องที่ออกอยู่', status: 'out'),
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: _TodayStat(
            inN: c.todayIn,
            outN: c.todayOut,
            onTap: () => _showTodayEventsSheet(context, c),
          ),
        ),
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
    // Grouped by where a box is in its life, not by which screen happens to
    // exist: Inbound -> Internal -> Outbound -> Audit/Exception. An operator
    // walking to the dock knows which of those four they are doing before
    // they pick up the terminal, so that is the first decision the menu asks
    // for. Routine groups are open; the ones that are occasional start
    // collapsed so the daily path stays a single screen with no scrolling.
    ..._menuGroups(c),
    if (c.outbox.isNotEmpty || c.damagedFlags.any((f) => !f.synced)) ...[
      const SizedBox(height: 14),
      _OutboxBanner(c: c, onSync: c.syncNow),
    ],
  ];
}

/// The four WMS stages, in the order a box moves through them. Each group is
/// one collapsible section; the items inside are the screens that actually do
/// that stage's work.
///
/// Gate direction still filters what shows: a door configured IN-only never
/// offers Gate Out, and vice versa. Permission (`canScan`) and connectivity
/// gate individual items exactly as before — a menu entry that cannot work is
/// hidden rather than shown disabled, because a dead tap is worse than an
/// absent one on a handheld.
List<Widget> _menuGroups(AppController c) {
  final pendingDamage = c.damagedFlags.where((f) => !f.synced).length;

  final inbound = <Widget>[
    // Receiving writes a brand-new box row the moment it's tapped and has no
    // local outbox path, so starting it offline would strand the operator.
    if (c.canScan && c.connected)
      _MenuItem(
        icon: Icons.add_box,
        iconColor: C.limeText,
        iconBg: C.limeBg,
        title: 'รับกล่องใหม่จาก Supplier',
        sub: 'สร้างกล่อง → ติดป้าย → ผูก RFID → Putaway',
        onTap: c.goBoxRegister,
      ),
    if (c.canScan && c.currentGateType != 'out')
      _MenuItem(
        icon: Icons.south,
        iconColor: C.lime,
        iconBg: C.limeBg,
        title: 'รับคืนกล่อง',
        sub: 'Gate In — ยิงกล่องกลับเข้าคลัง',
        onTap: c.goScanIn,
      ),
    // Standalone tag commissioning: nested here rather than sitting on the
    // top level, because binding a tag outside of receiving is the exception
    // (a label that fell off), not a daily task.
    if (c.canScan)
      _MenuItem(
        icon: Icons.qr_code_scanner,
        iconColor: C.ink2,
        iconBg: C.neutralBg,
        title: 'ลงทะเบียนแท็ก RFID',
        sub: 'ผูกแท็กให้กล่องที่มีอยู่แล้ว (แท็กหลุด/เปลี่ยนใหม่)',
        onTap: c.goRfidRegister,
      ),
  ];

  final outbound = <Widget>[
    if (c.canScan && c.currentGateType != 'in')
      _MenuItem(
        icon: Icons.north,
        iconColor: C.orange,
        iconBg: C.orangeBg,
        title: 'จ่ายกล่องออกให้ลูกค้า',
        sub: 'Gate Out — ยิงกล่องออกจากคลัง',
        onTap: c.goScanOut,
      ),
    if (c.canScan && c.connected)
      _MenuItem(
        icon: Icons.swap_horiz,
        iconColor: C.ink2,
        iconBg: C.neutralBg,
        title: 'ย้ายตำแหน่งจัดเก็บ',
        sub: 'Relocate — ย้ายกล่องไปโซน/แร็คอื่นในคลัง',
        onTap: c.goRelocate,
      ),
  ];

  final search = <Widget>[
    _MenuItem(
      icon: Icons.search,
      iconColor: C.ink2,
      iconBg: C.neutralBg,
      title: 'ค้นหาตำแหน่ง / ประวัติกล่อง',
      sub: 'Track — สถานะ ตำแหน่งล่าสุด ประวัติเข้า-ออก',
      onTap: c.goTrack,
    ),
    _MenuItem(
      icon: Icons.nfc,
      iconColor: C.ink2,
      iconBg: C.neutralBg,
      title: 'เรดาร์หากล่องด้วย RFID',
      sub: 'Geiger — เดินกวาดหากล่องที่หาไม่เจอบนแร็ค',
      onTap: c.goLocate,
    ),
  ];

  final audit = <Widget>[
    if (c.canScan)
      _MenuItem(
        icon: Icons.fact_check_outlined,
        iconColor: C.ink2,
        iconBg: C.neutralBg,
        title: 'ตรวจนับสต็อก',
        sub: 'Cycle Count — กวาดทั้งโซน/แร็ค แล้วเทียบกับระบบ',
        onTap: c.goCycleCount,
      ),
    // Never gated on connectivity: this writes to the local queue and syncs
    // later, so hiding it offline would remove the one report an operator
    // most needs when the network is down.
    if (c.canScan)
      _MenuItem(
        icon: Icons.report_gmailerrorred,
        iconColor: C.red,
        iconBg: C.orangeBg,
        title: 'แจ้งกล่องชำรุด / สูญหาย',
        sub: pendingDamage > 0
            ? 'บันทึกได้แม้ออฟไลน์ — รอซิงค์ $pendingDamage รายการ'
            : 'บันทึกได้แม้ออฟไลน์ — จะซิงค์อัตโนมัติ',
        onTap: c.goDamagedBox,
      ),
  ];

  final groups = <Widget>[
    if (inbound.isNotEmpty)
      _MenuGroup(
        emoji: '📦',
        title: 'รับกล่องเข้า',
        subtitle: 'Inbound / Return',
        initiallyOpen: true,
        children: inbound,
      ),
    if (outbound.isNotEmpty)
      _MenuGroup(
        emoji: '🚚',
        title: 'จ่ายกล่องออก',
        subtitle: 'Outbound / Transfer',
        initiallyOpen: true,
        children: outbound,
      ),
    _MenuGroup(
      emoji: '🔍',
      title: 'ค้นหา & ติดตาม',
      subtitle: 'Search & Audit',
      children: search,
    ),
    if (audit.isNotEmpty)
      _MenuGroup(
        emoji: '📋',
        title: 'ตรวจนับ & แจ้งปัญหา',
        subtitle: 'Count & Issues',
        badge: pendingDamage > 0 ? '$pendingDamage' : null,
        children: audit,
      ),
  ];

  return [
    for (var i = 0; i < groups.length; i++) ...[
      if (i > 0) const SizedBox(height: 10),
      groups[i],
    ],
  ];
}

/// One collapsible stage of the menu. Stateful only so each group remembers
/// its own open/closed state as the operator works — the rest of this screen
/// is stateless and rebuilds on every notifyListeners().
class _MenuGroup extends StatefulWidget {
  final String emoji, title, subtitle;
  final String? badge;
  final bool initiallyOpen;
  final List<Widget> children;
  const _MenuGroup({
    required this.emoji,
    required this.title,
    required this.subtitle,
    required this.children,
    this.badge,
    this.initiallyOpen = false,
  });

  @override
  State<_MenuGroup> createState() => _MenuGroupState();
}

class _MenuGroupState extends State<_MenuGroup> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: C.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Row(
                children: [
                  Text(widget.emoji, style: const TextStyle(fontSize: 19)),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(widget.title,
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                        Text(widget.subtitle, style: TextStyle(fontSize: 11.5, color: C.faint)),
                      ],
                    ),
                  ),
                  if (widget.badge != null) ...[
                    Pill(widget.badge!, color: C.orange, bg: C.orangeBg, fontSize: 11),
                    const SizedBox(width: 8),
                  ],
                  Icon(_open ? Icons.expand_less : Icons.expand_more, size: 22, color: C.chevron),
                ],
              ),
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
              child: Column(children: widget.children),
            ),
        ],
      ),
    );
  }
}

/// A leaf action inside a [_MenuGroup]. Flatter than the old top-level
/// _ActionCard on purpose — the group card already supplies the frame, and
/// nesting two bordered cards reads as clutter on a 4" screen.
class _MenuItem extends StatelessWidget {
  final IconData icon;
  final Color iconColor, iconBg;
  final String title, sub;
  final VoidCallback onTap;
  const _MenuItem({
    required this.icon,
    required this.iconColor,
    required this.iconBg,
    required this.title,
    required this.sub,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 11),
          child: Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(color: iconBg, borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, color: iconColor, size: 22),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700)),
                    Text(sub, style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, size: 19, color: C.chevron),
            ],
          ),
        ),
      ),
    );
  }
}

/// Shared shell every detail sheet on this screen uses — drag handle,
/// scroll-capped growth, safe-area bottom padding. Kept as one function so
/// a screen too short for the full list (see the earlier "BOTTOM
/// OVERFLOWED" fix on the handover sheet) is fixed everywhere at once.
void _showDetailSheet(BuildContext context, {required String title, required List<Widget> children}) {
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (sheetCtx) => Container(
      margin: EdgeInsets.fromLTRB(12, 12, 12, 12 + MediaQuery.of(sheetCtx).padding.bottom),
      constraints: BoxConstraints(maxHeight: MediaQuery.of(sheetCtx).size.height * 0.78),
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
      decoration: BoxDecoration(color: C.surface, borderRadius: BorderRadius.circular(22)),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Center(
            child: Container(
              width: 36,
              height: 4,
              margin: const EdgeInsets.only(bottom: 14),
              decoration: BoxDecoration(color: C.border2, borderRadius: BorderRadius.circular(2)),
            ),
          ),
          Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          Flexible(child: SingleChildScrollView(child: Column(children: children))),
        ],
      ),
    ),
  );
}

Widget _detailRow({required String title, required String subtitle, Widget? trailing}) {
  return Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: C.neutralBg,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: C.border),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
                Text(subtitle, style: TextStyle(fontSize: 12, color: C.muted)),
              ],
            ),
          ),
          if (trailing != null) trailing,
        ],
      ),
    ),
  );
}

/// "ในคลัง" / "ออกอยู่" stat tap — the actual list of boxes behind that
/// number, not just the count. [status] matches Box.status directly.
void _showBoxListSheet(BuildContext context, AppController c, {required String title, required String status}) {
  final S = c.S;
  final boxes = (S?.boxes ?? const <Box>[]).where((b) => b.status == status).toList()
    ..sort((a, b) => a.tag.compareTo(b.tag));
  _showDetailSheet(
    context,
    title: '$title (${boxes.length})',
    children: boxes.isEmpty
        ? [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: Center(child: Text('ไม่มีกล่อง', style: TextStyle(fontSize: 13, color: C.faint))),
            ),
          ]
        : boxes.map((b) {
            final sub = status == 'out'
                ? S!.custName(b.customer)
                : [
                    S!.whName(b.location['wh']?.toString()),
                    if ((b.location['zone'] ?? '').toString().isNotEmpty) 'โซน ${b.location['zone']}',
                  ].join(' · ');
            return _detailRow(
              title: b.tag,
              subtitle: '${S.typeName(b.type)} · $sub',
            );
          }).toList(),
  );
}

/// "วันนี้" stat tap — every in/out event from today, newest first.
void _showTodayEventsSheet(BuildContext context, AppController c) {
  final events = (c.S?.events ?? const [])
      .whereType<Map>()
      .where((e) {
        final dir = e['dir'];
        if (dir != 'in' && dir != 'in-new' && dir != 'out') return false;
        final ts = e['ts']?.toString();
        if (ts == null) return false;
        final d = DateTime.tryParse(ts)?.toLocal();
        if (d == null) return false;
        final n = DateTime.now();
        return d.year == n.year && d.month == n.month && d.day == n.day;
      })
      .toList()
    ..sort((a, b) => (b['ts']?.toString() ?? '').compareTo(a['ts']?.toString() ?? ''));
  _showDetailSheet(
    context,
    title: 'วันนี้ (${events.length})',
    children: events.isEmpty
        ? [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: Center(child: Text('ยังไม่มีรายการวันนี้', style: TextStyle(fontSize: 13, color: C.faint))),
            ),
          ]
        : events.map((e) {
            final dir = e['dir'];
            final isOut = dir == 'out';
            final ts = DateTime.tryParse(e['ts']?.toString() ?? '')?.toLocal();
            final time = ts == null
                ? ''
                : '${ts.hour.toString().padLeft(2, '0')}:${ts.minute.toString().padLeft(2, '0')}';
            final who = (e['recorder'] ?? '').toString();
            return _detailRow(
              title: (e['tag'] ?? '').toString(),
              subtitle: [time, if (who.isNotEmpty) who].join(' · '),
              trailing: Pill(isOut ? 'ออก' : 'เข้า',
                  color: isOut ? C.orange : C.limeText, bg: isOut ? C.orangeBg : C.limeBg),
            );
          }).toList(),
  );
}

/// Handover sheet: end this person's session, or hand the device to the next
/// one. Both do the same thing — return to the badge screen — because a
/// handover *is* the sign-out. The device itself stays signed in and stationed
/// where it is, so the next operator is one badge scan away from working.
void _openHandover(BuildContext context, AppController c) {
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    // Default (isScrollControlled: false) caps the sheet at ~half the
    // screen — fine on a phone, but this device's short/wide display left
    // "เปลี่ยนคน / จบงาน" + up to two more action tiles with nowhere to go
    // ("BOTTOM OVERFLOWED BY 81 PIXELS"). isScrollControlled lets it grow to
    // fit its content up to the full screen height instead of a fixed cap;
    // the SingleChildScrollView below is the fallback for whatever's left
    // over on a screen too short even for that.
    isScrollControlled: true,
    builder: (sheetCtx) => Container(
      margin: EdgeInsets.fromLTRB(12, 12, 12, 12 + MediaQuery.of(sheetCtx).padding.bottom),
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
      decoration: BoxDecoration(color: C.surface, borderRadius: BorderRadius.circular(22)),
      child: SingleChildScrollView(
        child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Same drag-handle bar the PIN pad sheet uses — this sheet drags
          // down to dismiss same as any modal sheet, but with padding.all
          // the same on every edge there was nothing visually marking that
          // affordance the way iOS's own sheets always do.
          Center(
            child: Container(
              width: 36,
              height: 4,
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(color: C.border2, borderRadius: BorderRadius.circular(2)),
            ),
          ),
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
        ],
        ),
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
    // heroBg/onHero (not ink/onInk) — this tile is meant to always look like
    // a dark accent card with a lime badge on it, in both themes. ink/onInk
    // invert with the theme (correctly, for actual body text), so using them
    // here meant this tile flipped to a near-white card with a barely-visible
    // lime-on-light-gray badge the moment dark mode was on — exactly the
    // "badge สีเทา ข้อความสีเขียว" contrast bug this fixes. See theme.dart's
    // own note on heroBg for the same lesson learned elsewhere already.
    return Material(
      color: highlighted ? C.heroBg : C.neutralBg,
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
                        color: highlighted ? C.onHero : null)),
              ),
              if (tag != null) ...[
                Pill(tag!, color: C.lime, bg: C.onHero.withValues(alpha: 0.14)),
                const SizedBox(width: 8),
              ],
              Icon(Icons.chevron_right, size: 20, color: highlighted ? C.onHero.withValues(alpha: 0.5) : C.chevron),
            ],
          ),
        ),
      ),
    );
  }
}

class _GatePickChip extends StatelessWidget {
  final String label;
  final String type;
  final VoidCallback onTap;
  const _GatePickChip({required this.label, required this.type, required this.onTap});

  // ขาเข้า/ขาออก ต้องเป็นสีตรงข้ามกันชัดเจน (เขียว vs แดง) ส่วนไม้ tone อ่อนของ
  // C.lime/C.orange ที่ใช้ในการ์ดเมนูหลักไม่ต่างกันพอเมื่อโชว์เป็น label เล็กๆ
  static const _inColor = Color(0xFF1E8E3E);
  static const _outColor = Color(0xFFD93025);

  // 'in' | 'out' | 'both' -> spans สีตรงข้ามกัน; 'both' โชว์ทั้งสองคำต่อกัน
  List<TextSpan> get _typeSpans {
    const style = TextStyle(fontSize: 11, fontWeight: FontWeight.w700);
    final inSpan = TextSpan(text: 'เข้า', style: style.copyWith(color: _inColor));
    final outSpan = TextSpan(text: 'ออก', style: style.copyWith(color: _outColor));
    return switch (type) {
      'in' => [inSpan],
      'out' => [outSpan],
      _ => [inSpan, TextSpan(text: '·', style: TextStyle(fontSize: 11, color: C.border2)), outSpan],
    };
  }

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
              Text.rich(TextSpan(children: _typeSpans)),
            ],
          ),
        ),
      ),
    );
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
  final VoidCallback? onTap;
  const _Stat({required this.value, required this.label, this.valueColor, this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Panel(
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
        ),
      ),
    );
  }
}

class _TodayStat extends StatelessWidget {
  final int inN, outN;
  final VoidCallback? onTap;
  const _TodayStat({required this.inN, required this.outN, this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Panel(
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
        ),
      ),
    );
  }
}

class _PendingItem {
  final DateTime at;
  final String title;
  final String subtitle;
  const _PendingItem(this.at, this.title, this.subtitle);
}

List<_PendingItem> _pendingItems(AppController c) {
  final items = <_PendingItem>[
    ...c.outbox.map((tx) {
      final at = DateTime.tryParse(tx.ts) ?? DateTime.now();
      final title = tx.type == 'in' ? 'รับคืน ${tx.tags.length} กล่อง' : 'ส่งออก ${tx.tags.length} กล่อง';
      final who = c.S?.custName(tx.customer ?? '') ?? tx.customer;
      final subtitle = [
        if (tx.type == 'out' && (who ?? '').isNotEmpty) '→ $who',
        'ประตู ${tx.gate}',
        tx.recorder,
      ].join(' · ');
      return _PendingItem(at, title, subtitle);
    }),
    ...c.damagedFlags.where((f) => !f.synced).map(
          (f) => _PendingItem(f.createdAt, 'แจ้งเสียหาย ${f.barcode}',
              f.rfidEpcs.isEmpty ? 'ไม่มี RFID' : '${f.rfidEpcs.length} แท็ก RFID'),
        ),
  ];
  items.sort((a, b) => b.at.compareTo(a.at)); // newest first
  return items;
}

String _fmtHm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

class _OutboxBanner extends StatelessWidget {
  final AppController c;
  final VoidCallback onSync;
  const _OutboxBanner({required this.c, required this.onSync});
  @override
  Widget build(BuildContext context) {
    final items = _pendingItems(c);
    return GestureDetector(
      onTap: () => _showDetailSheet(
        context,
        title: 'รอซิงก์ (${items.length})',
        children: items.isEmpty
            ? [Text('ไม่มีรายการค้าง', style: TextStyle(fontSize: 13, color: C.faint))]
            : items
                .map((i) => _detailRow(
                      title: i.title,
                      subtitle: '${i.subtitle} · ${_fmtHm(i.at)}',
                    ))
                .toList(),
      ),
      child: Container(
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
              child: Text('${items.length}',
                  style: TextStyle(
                      color: C.onInk,
                      fontWeight: FontWeight.w700,
                      fontSize: 14,
                      fontFeatures: [FontFeature.tabularFigures()])),
            ),
            const SizedBox(width: 11),
            Expanded(
              child: Text('รายการค้าง sync (ออฟไลน์) — แตะเพื่อดูว่าทำอะไรไปแล้วบ้าง',
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
      ),
    );
  }
}
