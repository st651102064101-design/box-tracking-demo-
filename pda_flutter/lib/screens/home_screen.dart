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
    const Caption('งานหลัก'),
    const SizedBox(height: 10),
    // Gate In/Out first — the day-to-day traffic through this screen, far
    // more often than receiving a brand-new box off a supplier truck.
    // ประตูที่ตั้งเป็น IN หรือ OUT อย่างเดียว (ไม่ใช่ both) แสดงได้แค่เมนูที่ตรงทิศทาง
    // ของประตูนั้น — กันไม่ให้ยิงกล่องออกจากประตูที่ตั้งไว้เป็นทางเข้าอย่างเดียว (หรือกลับกัน)
    if (c.canScan && c.currentGateType != 'out') ...[
      _ActionCard(
        dark: true,
        icon: Icons.south,
        iconColor: C.lime,
        iconBg: C.onInk.withValues(alpha: 0.12),
        title: 'รับคืน',
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
    // Box registration writes a brand-new box row the moment it's tapped
    // (see BoxRegisterScreen._submitCreate) — there's no local outbox path
    // for that the way gate scans have, so starting it offline would just
    // strand the operator mid-flow. Hidden entirely rather than shown
    // disabled: a menu item that's there but won't work invites exactly the
    // tap that fails.
    if (c.canScan && c.connected) ...[
      _ActionCard(
        icon: Icons.add_box,
        iconColor: C.limeText,
        iconBg: C.limeBg,
        title: 'ลงทะเบียนกล่อง',
        sub: 'รับกล่องจาก supplier — สร้างกล่อง ติดป้าย ผูกแท็ก แล้ว Putaway',
        onTap: c.goBoxRegister,
      ),
      const SizedBox(height: 12),
    ],
    // Damage flagging is intentionally never gated on c.connected (unlike
    // box registration above) — it writes only to the local queue until
    // AppController.flushDamagedFlags gets a chance to sync, so there's no
    // reason to hide it just because the terminal is offline right now.
    if (c.canScan) ...[
      _ActionCard(
        small: true,
        icon: Icons.report_gmailerrorred,
        iconColor: C.red,
        iconBg: C.orangeBg,
        title: 'แจ้งกล่องเสียหาย',
        sub: c.damagedFlags.any((f) => !f.synced)
            ? 'เลือกบาร์โค้ดหรือ RFID — รอซิงค์ ${c.damagedFlags.where((f) => !f.synced).length} รายการ'
            : 'เลือกบาร์โค้ดหรือ RFID แล้วบันทึกได้แม้ออฟไลน์',
        onTap: c.goDamagedBox,
      ),
      const SizedBox(height: 12),
    ],
    // Moved here from Settings — commissioning a tag is a routine
    // warehouse-floor action alongside Gate In/Out, not device config.
    if (c.canScan) ...[
      _ActionCard(
        small: true,
        icon: Icons.qr_code_scanner,
        iconColor: C.ink2,
        iconBg: C.neutralBg,
        title: 'ลงทะเบียนแท็ก RFID',
        sub: 'สแกนบาร์โค้ด แล้วยิงแท็กเพื่อผูกกับกล่องนั้นทันที',
        onTap: c.goRfidRegister,
      ),
      const SizedBox(height: 12),
    ],
    _ActionCard(
      small: true,
      icon: Icons.nfc,
      iconColor: C.ink2,
      iconBg: C.neutralBg,
      title: 'หากล่อง / RFID',
      sub: 'เลือกกล่อง แล้วกวาดหาสัญญาณแบบ Geiger',
      onTap: c.goLocate,
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
    if (c.outbox.isNotEmpty || c.damagedFlags.any((f) => !f.synced)) ...[
      const SizedBox(height: 14),
      _OutboxBanner(c: c, onSync: c.syncNow),
    ],
  ];
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
    // Every card on this screen carries a blurred shadow — cheap one at a
    // time, not cheap five deep on a screen that redraws on every
    // notifyListeners(). C.shadow() (see theme.dart) drops it to a flat
    // border, now permanently since C.lowGraphics is a const true.
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
            boxShadow: C.shadow([
              BoxShadow(
                color: Colors.black.withOpacity(dark ? 0.14 : 0.06),
                blurRadius: dark ? 24 : (small ? 0 : 20),
                offset: Offset(0, dark ? 8 : 6),
              )
            ]),
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

/// What actually happened while this terminal had no signal — every queued
/// gate scan and damage report, in one plain-language list, so "did that
/// receipt actually go through?" has an answer on the device right now
/// instead of only once someone checks the web app after it syncs.
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
