import 'package:flutter/material.dart';

import '../theme.dart';
import 'prefs.dart';

/// TH/EN toggle for the PDA app, mirroring the language switch already used
/// in the BoxTrace web reference mockup (`btnLang` / `toggleLang()` there):
/// Thai copy is the source of truth in the widget tree, this just swaps in an
/// English string when one is known and persists the choice like the mockup
/// does via localStorage.
class LocaleController extends ChangeNotifier {
  final Prefs prefs;
  LocaleController(this.prefs) : lang = prefs.lang;

  String lang; // 'th' | 'en'

  void toggle() {
    lang = lang == 'th' ? 'en' : 'th';
    prefs.lang = lang;
    notifyListeners();
  }

  /// Look up [th] in the dictionary and return its English counterpart when
  /// the current language is 'en'; otherwise return [th] unchanged.
  String t(String th) => lang == 'en' ? (_dict[th] ?? th) : th;

  static const Map<String, String> _dict = {
    // badge screen
    'ยิงบัตรพนักงานเพื่อเริ่มงาน': 'Scan your badge to start',
    'ยิงบัตร หรือพิมพ์รหัสพนักงาน': 'Scan a badge, or type an employee id',
    'ทุกการยิงเข้า–ออกจะบันทึกในชื่อผู้ที่ยิงบัตร':
        'Every in/out scan is logged under the badge that was scanned',
    'หรือแตะชื่อของคุณ': 'or tap your name',
    'ยังไม่ได้ตั้งค่าเครื่อง': 'Device not set up yet',
    'ตั้งค่าการเชื่อมต่อ': 'Connection settings',
    'ยังไม่มีพนักงานในระบบ': 'No employees on file yet',
    'รอเชื่อมต่อกับระบบหลักก่อน': 'Waiting to connect to the main system',
    'ยังไม่พบข้อมูลจากระบบหลัก BoxTrace — แตะปุ่มด้านล่างเพื่อตั้งค่าการเชื่อมต่อ':
        'No data from the BoxTrace main system yet — tap below to set up the connection',
    'เชื่อมต่อไม่ได้': 'Could not connect',
    'ผู้ดูแลระบบ': 'Administrator',

    // device setup screen
    'ตั้งค่าเครื่อง': 'Device setup',
    'ตั้งครั้งเดียว — พนักงานไม่ต้องเลือกอีก': 'Set once — operators never pick this again',
    '1 · การเชื่อมต่อระบบหลัก': '1 · Connection to the main system',
    'เชื่อมต่อแล้ว': 'Connected',
    'กล่อง': 'boxes',
    'ยังไม่พบข้อมูล': 'No data yet',
    'ที่อยู่เซิร์ฟเวอร์': 'Server address',
    'บัญชีประจำเครื่อง': 'Device account',
    'ชื่อบัญชีเครื่อง เช่น pda-01': 'Device account name, e.g. pda-01',
    'รหัสผ่าน (เว้นว่าง = ไม่เปลี่ยน)': 'Password (blank = unchanged)',
    'บัญชีนี้เป็นของเครื่อง ไม่ใช่ของพนักงาน — ตั้งครั้งเดียวตอนแจกเครื่อง':
        'This account belongs to the terminal, not to a person — set once when the device is issued',
    'กำลังเชื่อมต่อ…': 'Connecting…',
    'บันทึก & เชื่อมต่อ': 'Save & connect',
    '2 · เครื่องนี้ประจำคลังไหน': '2 · Which warehouse is this device stationed at',
    'เชื่อมต่อระบบหลักก่อน จึงจะเลือกคลังได้': 'Connect to the main system first to pick a warehouse',
    '3 · ประจำประตูไหน': '3 · Which gate',
    'ล็อกหน้าจอเมื่อไม่มีการใช้งาน': 'Lock the screen when idle',
    'ไม่ล็อก': 'Never',
    'นาที': 'min',
    'ยิงบัตรอีกครั้งเพื่อปลดล็อก · จะไม่ล็อกขณะมีกล่องค้างอยู่ในคิว':
        'Scan a badge to unlock · never locks while boxes are queued',
    'บันทึกและเริ่มใช้งาน': 'Save and start',
    'เลือกคลังและประตูก่อน': 'Select a warehouse and gate first',
    'เข้า': 'IN',
    'ออก': 'OUT',
    'เข้า/ออก': 'IN/OUT',
    'ประตู': 'Gate',
  };

  String gateRangeText(int? first, int? last) {
    if (first == null || last == null) return lang == 'en' ? 'Gate —' : 'ประตู —';
    return lang == 'en' ? 'Gate $first–$last' : 'ประตู $first–$last';
  }
}

/// Small "TH | EN" pill button, styled like a round icon button, meant to sit
/// in a screen's header actions.
class LangToggleButton extends StatelessWidget {
  final LocaleController loc;
  const LangToggleButton({super.key, required this.loc});

  @override
  Widget build(BuildContext context) {
    final isEn = loc.lang == 'en';
    return Material(
      color: C.neutralBg,
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: loc.toggle,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('TH',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: isEn ? FontWeight.w500 : FontWeight.w800,
                      color: isEn ? C.faint : C.ink)),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text('|', style: TextStyle(fontSize: 12, color: C.chevron)),
              ),
              Text('EN',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: isEn ? FontWeight.w800 : FontWeight.w500,
                      color: isEn ? C.ink : C.faint)),
            ],
          ),
        ),
      ),
    );
  }
}
