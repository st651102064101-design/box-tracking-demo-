import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  /// Physical number-key shortcut for the MC3390R's side keypad, matching
  /// the [1] badge on the sole _MenuTile this demo build shows — "press 1,
  /// land on Gate In" without touching the screen at all, for an operator
  /// whose hands are already full of a box. Both the top-row digit and the
  /// numeric-keypad variant are handled since which one a given handheld's
  /// keymap actually sends isn't something this app controls.
  static const _keyActions = <int, String>{
    1: 'in',
  };

  KeyEventResult _onKey(AppController c, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final digit = _digitFor(event.logicalKey);
    if (digit == null) return KeyEventResult.ignored;
    final action = _keyActions[digit];
    if (action == null) return KeyEventResult.ignored;
    switch (action) {
      case 'in':
        if (c.canScan && c.currentGateType != 'out') c.goScanIn();
        break;
    }
    return KeyEventResult.handled;
  }

  static final _topRow = {
    LogicalKeyboardKey.digit1: 1,
    LogicalKeyboardKey.digit2: 2,
    LogicalKeyboardKey.digit3: 3,
  };
  static final _numpad = {
    LogicalKeyboardKey.numpad1: 1,
    LogicalKeyboardKey.numpad2: 2,
    LogicalKeyboardKey.numpad3: 3,
  };

  static int? _digitFor(LogicalKeyboardKey key) => _topRow[key] ?? _numpad[key];

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final top = MediaQuery.of(context).padding.top;
    final bottom = MediaQuery.of(context).padding.bottom;

    return Focus(
      autofocus: true,
      onKeyEvent: (node, event) => _onKey(c, event),
      child: AutoHideHeader(
        header: Padding(
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
                                      fontSize: 17,
                                      fontWeight: FontWeight.w700,
                                      letterSpacing: -0.3)),
                            ),
                            const SizedBox(width: 4),
                            Icon(Icons.expand_more, size: 17, color: C.chevron),
                          ],
                        ),
                        Text(
                            c.postConfirmed
                                ? '${c.selWhName} · ${loc.t('ประตู')} ${c.gate}${_gateDirSuffix(c.currentGateType, loc)}'
                                : loc.t('ยังไม่ได้เลือกคลัง/ประตู'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 12, color: C.muted)),
                      ],
                    ),
                  ),
                ),
              ),
              OnlineChip(online: c.onlineDisplay, onTap: c.onlineChipTap),
              const SizedBox(width: 8),
              RoundIconButton(
                  icon: Icons.settings_outlined,
                  onTap: () => c.go(Screen.settings),
                  size: 38),
            ],
          ),
        ),
        body: Column(
          children: [
            Expanded(
              child: ListView(
                padding: EdgeInsets.fromLTRB(18, 14, 18, bottom + 20),
                children: [
                  if (!c.connected)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 14),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 15, vertical: 12),
                        decoration: BoxDecoration(
                          color: C.orangeBg,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: C.orangeBorder),
                        ),
                        child: Text(
                          loc.t(
                              'ยังไม่ได้เชื่อมข้อมูลกับระบบหลัก — ไปที่ตั้งค่าเพื่อเชื่อมต่อ หรือใส่ข้อมูลตัวอย่าง'),
                          style: TextStyle(
                              fontSize: 12.5,
                              color: C.orange,
                              fontWeight: FontWeight.w600,
                              height: 1.45),
                        ),
                      ),
                    ),
                  ...(c.postConfirmed
                      ? _confirmedBody(context, c)
                      : _postPickerBody(c, loc)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// รอยิงบัตรแล้ว แต่ยังไม่ได้ยืนยันคลัง/ประตูของรอบทำงานนี้ — "งานหลัก" ยังไม่โผล่
/// จนกว่าจะเลือกคลังแล้วเลือกประตูให้ครบ (ดู [AppController.selectPendingWh] /
/// [AppController.confirmPost])
List<Widget> _postPickerBody(AppController c, LocaleController loc) {
  final whs = c.warehouseList;
  if (whs.isEmpty) {
    return [
      const SizedBox(height: 16),
      _Note(loc.t('ยังไม่มีคลังในระบบ — ไปเพิ่มคลังที่ระบบหลักก่อน')),
    ];
  }
  final pendingWh = c.pendingWh;
  if (pendingWh == null) {
    final showLast = c.hasLastSelection &&
        whs.any((w) => (w['id'] ?? '').toString() == c.lastWh);
    return [
      const SizedBox(height: 16),
      Caption(loc.t('เลือกคลัง')),
      const SizedBox(height: 10),
      if (showLast) ...[
        _WhPickTile(
          name: '${c.lastWhName} · ${loc.t('ประตู')} ${c.lastGate}',
          tag: loc.t('ล่าสุด'),
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
        Expanded(child: Caption('${loc.t('เลือกประตู')} · $whName')),
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: c.clearPendingWh,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Text(loc.t('เปลี่ยนคลัง'),
                style: TextStyle(
                    fontSize: 12.5,
                    color: C.muted,
                    fontWeight: FontWeight.w600)),
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
  final loc = context.watch<LocaleController>();
  return [
    // This demo build only has Gate In — no ออกอยู่/out stat, and the
    // "today" tile reports just รับเข้า, not a combined in/out count.
    Row(
      children: [
        Expanded(
          child: _Stat(
            value: '${c.warehouseCount}',
            label: loc.t('ในคลัง'),
            onTap: () => _showBoxListSheet(context, c,
                title: loc.t('กล่องในคลัง'), status: 'warehouse'),
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: _Stat(
            value: '${c.todayIn}',
            label: loc.t('รับเข้าวันนี้'),
            onTap: () => _showTodayEventsSheet(context, c),
          ),
        ),
      ],
    ),
    if (c.emp != null && c.isVisiting(c.emp!))
      Padding(
        padding: const EdgeInsets.only(top: 14),
        child: _Note(
            '${loc.t('คุณประจำ')} ${c.S?.whName(c.emp!.wh) ?? c.emp!.wh} '
            '${loc.t('— รายการที่ยิงจะบันทึกที่')} ${c.selWhName} ${loc.t('ประตู')} ${c.gate}'),
      ),
    if (!c.canScan)
      Padding(
        padding: const EdgeInsets.only(top: 14),
        child: _Note(loc.t(
            'บัญชีนี้เป็นสิทธิ์ผู้ชม — ค้นหากล่องได้ แต่บันทึกเข้า/ออกไม่ได้')),
      ),
    const SizedBox(height: 16),
    // Product title strip sitting directly above the menu, as in the
    // reference layout. Names the hardware profile that was actually
    // detected at setup (see device_setup_screen's _detectDevice) rather
    // than hardcoding "MC3390R" — a build running on anything else says so.
    Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(
        color: C.heroBg,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(Icons.inventory_2_rounded, size: 19, color: C.lime),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              c.prefs.deviceModel == 'mc3390r'
                  ? 'AMS Mobile Tracker (MC3390R)'
                  : 'AMS Mobile Tracker',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: C.onHero,
                  letterSpacing: -0.2),
            ),
          ),
        ],
      ),
    ),
    const SizedBox(height: 12),
    // Numbered [1] — matches the physical number-key binding
    // (HomeScreen's KeyboardListener) so the badge an operator sees is the
    // same digit that jumps here from the keyboard.
    //
    // Demo build — this is the ONLY entry point the app has. Gate Out and
    // ผูก Tag / ชำรุด / อื่นๆ (More Hub) are both removed, not just hidden;
    // this branch exists to show Gate In alone. Still respects a gate
    // configured OUT-only — no way to actually receive there.
    if (c.canScan && c.currentGateType != 'out') ...[
      _MenuTile(
        number: 1,
        icon: Icons.inventory_2_outlined,
        color: C.menuGreen,
        bg: C.menuGreenBg,
        title: loc.t('รับเข้า'),
        sub: 'Gate In / Return',
        onTap: c.goScanIn,
      ),
      const SizedBox(height: 10),
    ],
    if (c.outbox.isNotEmpty) ...[
      const SizedBox(height: 14),
      _OutboxBanner(count: c.outbox.length, onSync: c.toggleOnline),
    ],
  ];
}

/// Shared shell every detail sheet on this screen uses — drag handle,
/// scroll-capped growth, safe-area bottom padding. Kept as one function so
/// a screen too short for the full list (see the earlier "BOTTOM
/// OVERFLOWED" fix on the handover sheet) is fixed everywhere at once.
void _showDetailSheet(BuildContext context,
    {required String title, required List<Widget> children}) {
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (sheetCtx) => Container(
      margin: EdgeInsets.fromLTRB(
          12, 12, 12, 12 + MediaQuery.of(sheetCtx).padding.bottom),
      constraints:
          BoxConstraints(maxHeight: MediaQuery.of(sheetCtx).size.height * 0.78),
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
      decoration: BoxDecoration(
          color: C.surface, borderRadius: BorderRadius.circular(22)),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Center(
            child: Container(
              width: 36,
              height: 4,
              margin: const EdgeInsets.only(bottom: 14),
              decoration: BoxDecoration(
                  color: C.border2, borderRadius: BorderRadius.circular(2)),
            ),
          ),
          Text(title,
              style:
                  const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          Flexible(
              child: SingleChildScrollView(child: Column(children: children))),
        ],
      ),
    ),
  );
}

Widget _detailRow(
    {required String title, required String subtitle, Widget? trailing}) {
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
                    style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        fontFamily: 'monospace')),
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

/// "ในคลัง" stat tap — the actual list of boxes behind that number, not
/// just the count. [status] matches Box.status directly.
void _showBoxListSheet(BuildContext context, AppController c,
    {required String title, required String status}) {
  final loc = context.read<LocaleController>();
  final S = c.S;
  final boxes = (S?.boxes ?? const <Box>[])
      .where((b) => b.status == status)
      .toList()
    ..sort((a, b) => a.tag.compareTo(b.tag));

  // Grouped by product type first, box tags listed underneath each — the
  // question standing at a shelf is "which type is this", not "give me
  // every box alphabetically with the type buried in a subtitle line", and
  // it reaches the answer in one tap with no dropdown/picker step at all.
  final byType = <String, List<Box>>{};
  for (final b in boxes) {
    byType.putIfAbsent(b.type ?? '', () => []).add(b);
  }
  final typeIds = byType.keys.toList()
    ..sort((a, b) => (S?.typeName(a) ?? a).compareTo(S?.typeName(b) ?? b));

  final children = <Widget>[];
  if (boxes.isEmpty) {
    children.add(Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Center(
          child: Text(loc.t('ไม่มีกล่อง'),
              style: TextStyle(fontSize: 13, color: C.faint))),
    ));
  } else {
    for (final typeId in typeIds) {
      final group = byType[typeId]!;
      children.add(Padding(
        padding: const EdgeInsets.fromLTRB(2, 14, 2, 6),
        child: Row(
          children: [
            Expanded(
              child: Text(S?.typeName(typeId) ?? typeId,
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w800)),
            ),
            Text('${group.length}',
                style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: C.muted)),
          ],
        ),
      ));
      children.addAll(group.map((b) {
        final sub = status == 'out'
            ? S!.custName(b.customer)
            : [
                S!.whName(b.location['wh']?.toString()),
                if ((b.location['zone'] ?? '').toString().isNotEmpty)
                  '${loc.t('โซน')} ${b.location['zone']}',
              ].join(' · ');
        return _detailRow(title: b.tag, subtitle: sub);
      }));
    }
  }

  _showDetailSheet(
    context,
    title: '$title (${boxes.length})',
    children: children,
  );
}

/// "วันนี้" stat tap — every in/out event from today, newest first.
void _showTodayEventsSheet(BuildContext context, AppController c) {
  final loc = context.read<LocaleController>();
  final events = (c.S?.events ?? const []).whereType<Map>().where((e) {
    final dir = e['dir'];
    if (dir != 'in' && dir != 'in-new' && dir != 'out') return false;
    final ts = e['ts']?.toString();
    if (ts == null) return false;
    final d = DateTime.tryParse(ts)?.toLocal();
    if (d == null) return false;
    final n = DateTime.now();
    return d.year == n.year && d.month == n.month && d.day == n.day;
  }).toList()
    ..sort((a, b) =>
        (b['ts']?.toString() ?? '').compareTo(a['ts']?.toString() ?? ''));
  _showDetailSheet(
    context,
    title: '${loc.t('วันนี้')} (${events.length})',
    children: events.isEmpty
        ? [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: Center(
                  child: Text(loc.t('ยังไม่มีรายการวันนี้'),
                      style: TextStyle(fontSize: 13, color: C.faint))),
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
              trailing: Pill(loc.t(isOut ? 'ออก' : 'เข้า'),
                  color: isOut ? C.orange : C.limeDeep,
                  bg: isOut ? C.orangeBg : C.limeBg),
            );
          }).toList(),
  );
}

/// Handover sheet: end this person's session, or hand the device to the next
/// one. Both do the same thing — return to the badge screen — because a
/// handover *is* the sign-out. The device itself stays signed in and stationed
/// where it is, so the next operator is one badge scan away from working.
void _openHandover(BuildContext context, AppController c) {
  final loc = context.read<LocaleController>();
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
      margin: EdgeInsets.fromLTRB(
          12, 12, 12, 12 + MediaQuery.of(sheetCtx).padding.bottom),
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
      decoration: BoxDecoration(
          color: C.surface, borderRadius: BorderRadius.circular(22)),
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
                decoration: BoxDecoration(
                    color: C.border2, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            Text(c.user,
                style:
                    const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            Text(
              [
                c.emp?.subtitle ?? '',
                '${c.selWhName} · ${loc.t('ประตู')} ${c.gate}'
              ].where((s) => s.isNotEmpty).join(' · '),
              style: TextStyle(fontSize: 12.5, color: C.muted),
            ),
            const SizedBox(height: 16),
            _SheetAction(
              icon: Icons.swap_horiz,
              label: loc.t('เปลี่ยนคน / จบงาน'),
              sub: loc.t('กลับไปหน้ายิงบัตร — เครื่องยังประจำประตูเดิม'),
              onTap: () {
                Navigator.of(sheetCtx).pop();
                c.lock();
              },
            ),
            if (c.canScan) ...[
              const SizedBox(height: 10),
              _SheetAction(
                icon: Icons.sync_alt,
                label: loc.t('เปลี่ยนคลัง/ประตู'),
                sub: loc.t('เลือกจุดทำงานใหม่สำหรับกะนี้'),
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
  const _WhPickTile(
      {required this.name, required this.onTap, this.tag, this.icon});
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
              Icon(Icons.chevron_right,
                  size: 20,
                  color:
                      highlighted ? C.onInk.withValues(alpha: 0.5) : C.chevron),
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
  const _GatePickChip(
      {required this.label, required this.type, required this.onTap});

  // ขาเข้า/ขาออก ต้องเป็นสีตรงข้ามกันชัดเจน (เขียว vs แดง) ส่วนไม้ tone อ่อนของ
  // C.lime/C.orange ที่ใช้ในการ์ดเมนูหลักไม่ต่างกันพอเมื่อโชว์เป็น label เล็กๆ
  static const _inColor = Color(0xFF1E8E3E);
  static const _outColor = Color(0xFFD93025);

  // 'in' | 'out' | 'both' -> spans สีตรงข้ามกัน; 'both' โชว์ทั้งสองคำต่อกัน
  List<TextSpan> _typeSpans(LocaleController loc) {
    const style = TextStyle(fontSize: 11, fontWeight: FontWeight.w700);
    final inSpan =
        TextSpan(text: loc.t('เข้า'), style: style.copyWith(color: _inColor));
    final outSpan =
        TextSpan(text: loc.t('ออก'), style: style.copyWith(color: _outColor));
    return switch (type) {
      'in' => [inSpan],
      'out' => [outSpan],
      _ => [
          inSpan,
          TextSpan(text: '·', style: TextStyle(fontSize: 11, color: C.border2)),
          outSpan
        ],
    };
  }

  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocaleController>();
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
          decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(13),
              border: Border.all(color: C.border2)),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('${loc.t('ประตู')} $label',
                  style: const TextStyle(
                      fontSize: 15, fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              Text.rich(TextSpan(children: _typeSpans(loc))),
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
  const _SheetAction(
      {required this.icon,
      required this.label,
      required this.sub,
      required this.onTap});

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
                    Text(label,
                        style: const TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w600)),
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
        child: Text(text,
            style: TextStyle(fontSize: 12.5, color: C.ink3, height: 1.4)),
      );
}

String _gateDirSuffix(String dir, LocaleController loc) {
  switch (dir) {
    case 'in':
      return ' (${loc.t('เข้า')})';
    case 'out':
      return ' (${loc.t('ออก')})';
    default:
      return '';
  }
}

class _Stat extends StatelessWidget {
  final String value, label;
  final Color? valueColor;
  final VoidCallback? onTap;
  const _Stat(
      {required this.value, required this.label, this.valueColor, this.onTap});
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
              Text(label,
                  style: TextStyle(
                      fontSize: 11,
                      color: C.muted,
                      fontWeight: FontWeight.w500)),
            ],
          ),
        ),
      ),
    );
  }
}

/// The primary-menu button (just one, in this demo build). Fixed 72dp tall —
/// inside the 64-80dp touch-target range a scanner-gun grip (thick gloves,
/// one-handed use, walking) actually needs, not the ~48dp a phone-held-in-
/// two-hands app can get away with — and a coloured number badge on the left
/// matching HomeScreen's number-key binding (press "1" to jump here without
/// touching the screen at all).
class _MenuTile extends StatelessWidget {
  final int number;
  final IconData icon;
  final Color color;
  final Color bg;
  final String title;
  final String sub;
  final VoidCallback onTap;
  const _MenuTile({
    required this.number,
    required this.icon,
    required this.color,
    required this.bg,
    required this.title,
    required this.sub,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final lowPower = context.select<AppController, bool>((c) => c.lowPowerMode);
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 72),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: C.border),
            boxShadow: lowPower
                ? null
                : [
                    BoxShadow(
                        color: Colors.black.withValues(alpha: 0.05),
                        blurRadius: 14,
                        offset: const Offset(0, 4))
                  ],
          ),
          child: Row(
            children: [
              // Number badge — same colour family as the icon tile, one
              // step lighter, so the digit reads as "part of this button"
              // rather than a separate decoration.
              SizedBox(
                width: 22,
                child: Text('$number',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w800,
                        color: color.withValues(alpha: 0.55))),
              ),
              const SizedBox(width: 8),
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                    color: bg, borderRadius: BorderRadius.circular(14)),
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
                            fontSize: 17, fontWeight: FontWeight.w700)),
                    Text(sub,
                        style: TextStyle(
                            fontSize: 12, color: C.muted, letterSpacing: 0.2)),
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

class _OutboxBanner extends StatelessWidget {
  final int count;
  final VoidCallback onSync;
  const _OutboxBanner({required this.count, required this.onSync});
  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocaleController>();
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
            decoration: BoxDecoration(
                color: C.orange, borderRadius: BorderRadius.circular(10)),
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
            child: Text(
                loc.t(
                    'รายการค้าง sync (ออฟไลน์) — จะส่งเข้าระบบเมื่อกลับมาออนไลน์'),
                style: TextStyle(
                    fontSize: 12.5,
                    color: C.ink3,
                    height: 1.4,
                    fontWeight: FontWeight.w500)),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: onSync,
            style: FilledButton.styleFrom(
              backgroundColor: C.ink,
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10)),
              minimumSize: Size.zero,
            ),
            child: const Text('Sync',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}
