import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// "เมนูอื่นๆ" — the second (and last) primary-menu slot, for floor actions
/// besides Gate In/Out: looking a box up (Track), ตรวจนับ (Cycle Count), and
/// ค้นหา/เรดาร์ (RFID Locate — finds a box that already has a tag, doesn't
/// bind one).
///
/// Deliberately excluded: "ลงทะเบียนกล่องใหม่" (its create→label→**rfid**→
/// **putaway** flow), "ย้ายตำแหน่ง" (a zone/rack/shelf/slot picker built on
/// the same putawayBox call), and "เช็คช่อง" (a rack/shelf lookup) — none of
/// those files were deleted (still routable via AppController.goBoxRegister
/// / goTransfer / goLocationInquiry if a future build wants them back), they
/// just have no tile here since this build has no Putaway/rack/RFID-binding
/// menu.
class MoreHubScreen extends StatelessWidget {
  const MoreHubScreen({super.key});

  /// Same physical number-key convention as HomeScreen — matches the [1]-[4]
  /// badges each _tile shows below.
  static const _keyActions = <int, String>{
    1: 'track',
    2: 'cycleCount',
    3: 'locate',
  };

  KeyEventResult _onKey(AppController c, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final digit = _digitFor(event.logicalKey);
    if (digit == null) return KeyEventResult.ignored;
    final action = _keyActions[digit];
    if (action == null) return KeyEventResult.ignored;
    switch (action) {
      case 'track':
        c.goTrack();
        break;
      case 'cycleCount':
        c.goCycleCount();
        break;
      case 'locate':
        c.goLocate();
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
          title: Text(loc.t('เมนูอื่นๆ')),
        ),
        body: Column(
          children: [
            Expanded(
              child: ListView(
                padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
                children: [
                  _tile(
                    number: 1,
                    icon: Icons.search,
                    color: C.ink2,
                    bg: C.neutralBg,
                    title: loc.t('ค้นหา / ตรวจสอบกล่อง'),
                    sub: loc.t('Track — ดูสถานะ ตำแหน่ง ประวัติ'),
                    onTap: c.goTrack,
                  ),
                  const SizedBox(height: 10),
                  _tile(
                    number: 2,
                    icon: Icons.checklist,
                    color: C.menuOrange,
                    bg: C.menuOrangeBg,
                    title: loc.t('ตรวจนับ'),
                    sub: 'Cycle Count',
                    onTap: c.goCycleCount,
                  ),
                  const SizedBox(height: 10),
                  _tile(
                    number: 3,
                    icon: Icons.radar,
                    color: C.menuOrange,
                    bg: C.menuOrangeBg,
                    title: loc.t('ค้นหา/เรดาร์'),
                    sub: 'Search / Radar',
                    onTap: c.goLocate,
                  ),
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
