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
    'ยังไม่ได้เลือกคลัง/ประตู': 'No warehouse/gate picked yet',
    'ตั้งค่าการเชื่อมต่อ': 'Connection settings',
    'ยังไม่มีพนักงานในระบบ': 'No employees on file yet',
    'รอเชื่อมต่อกับระบบหลักก่อน': 'Waiting to connect to the main system',
    'ยังไม่พบข้อมูลจากระบบหลัก BoxTrace — แตะปุ่มด้านล่างเพื่อตั้งค่าการเชื่อมต่อ':
        'No data from the BoxTrace main system yet — tap below to set up the connection',
    'เชื่อมต่อไม่ได้': 'Could not connect',
    'ผู้ดูแลระบบ': 'Administrator',
    'ยืนยัน': 'Confirm',

    // device setup screen
    'ตั้งค่าเครื่อง': 'Device setup',
    'เชื่อมต่อครั้งเดียว — เลือกคลัง/ประตูตอนเริ่มงานแทน':
        'Connect once — pick the warehouse/gate when starting a task instead',
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
    'ล็อกหน้าจอเมื่อไม่มีการใช้งาน': 'Lock the screen when idle',
    'ไม่ล็อก': 'Never',
    'นาที': 'min',
    'ยิงบัตรอีกครั้งเพื่อปลดล็อก · จะไม่ล็อกขณะมีกล่องค้างอยู่ในคิว':
        'Scan a badge to unlock · never locks while boxes are queued',
    'บันทึกและเริ่มใช้งาน': 'Save and start',
    'ประตู': 'Gate',
    '1 · อุปกรณ์ที่ใช้งาน': '1 · Device in use',
    '2 · การเชื่อมต่อระบบหลัก': '2 · Core system connection',
    'ระบุรุ่นอุปกรณ์พกพาที่ใช้งานเครื่องนี้ เพื่อให้ระบบตั้งค่าฟังก์ชันเครื่องอ่าน RFID ให้ถูกต้อง':
        'Specify the handheld model this terminal is running on, so the system configures its RFID reader correctly',
    'ขณะนี้ระบบรองรับอุปกรณ์รุ่นนี้เพียงรุ่นเดียว รุ่นอื่นจะเปิดให้เลือกในการอัปเดตครั้งถัดไป':
        'Only this model is currently supported — additional models will be added in a future update',
    'เครื่องอ่าน RFID ในตัวเครื่อง': 'Integrated RFID reader',

    // settings screen
    'ตั้งค่า': 'Settings',
    'การเชื่อมต่อระบบหลัก': 'Main system connection',
    'เชื่อมต่อกับ BoxTrace แล้ว': 'Connected to BoxTrace',
    'พบ': 'Found',
    'กล่องในฐานข้อมูล': 'boxes in the database',
    'โหมดประหยัดพลังงาน': 'Low power mode',
    'ลดกราฟฟิกและความถี่รีเฟรช เพื่อความเร็วบนเครื่อง': "Reduces graphics and refresh rate for speed on this device",
    'รับค่า RFID': 'Read RFID',
    'อ่านแท็กสด ๆ แบบไม่ผูกกับกล่อง — ดูความเร็วอ่านได้ที่นี่':
        "Read tags live, unlinked to any box — check read speed here",
    'เฉพาะหัวหน้างาน — เครื่องนี้ประจำ': "Supervisors only — this terminal is stationed at",
    'รหัส PIN ส่วนตัว': 'Personal PIN',
    'ตั้งไว้แล้ว — แตะเพื่อเปลี่ยนรหัส': 'Already set — tap to change it',
    'ยังไม่ได้ตั้ง — แตะเพื่อตั้งรหัสกันคนอื่นแตะชื่อคุณ':
        "Not set yet — tap to set one so no one else can tap your name",
    'เปลี่ยนคน / จบงาน': 'Switch person / end shift',
    'กลับไปหน้ายิงบัตร': 'Back to the badge screen',
    'เชื่อมกับ BoxTrace backend': 'Connected to the BoxTrace backend',
    'ใช้ได้เฉพาะบนเครื่อง Android ที่มีเครื่องอ่าน Zebra':
        'Only available on Android devices with a Zebra reader',
    'เชื่อมต่อเครื่องอ่านแล้ว': 'Reader connected',
    'เชื่อมต่อไม่สำเร็จ': 'Connection failed',
    'ตัดการเชื่อมต่อ': 'Disconnected',
    'ยังไม่ได้เชื่อมต่อ': 'Not connected yet',
    'เครื่องอ่าน RFID (Zebra)': 'RFID reader (Zebra)',
    'เชื่อมต่อใหม่': 'Reconnect',
    'ระยะยิงแท็ก': 'Tag read range',
    'กำลังยิงทดสอบ… แตะเพื่อหยุด': 'Test firing… tap to stop',
    'แตะเพื่อทดสอบยิง': 'Tap to test fire',
    'เชื่อมต่อเครื่องอ่านก่อน เพื่อปรับระยะยิงแบบละเอียดเต็มสเปกของเครื่องนี้':
        "Connect the reader first to fine-tune the range across this device's full spec",
    'กรองสัญญาณอ่อน (RSSI)': 'Filter weak signal (RSSI)',
    'ตัดทิ้งแท็กที่อ่านได้อ่อนกว่าค่าที่ตั้ง — กันอ่านทะลุไปโดนพาเลทข้างๆ':
        "Drops tags read weaker than the set threshold — keeps reads from bleeding into the next pallet over",
    'เสียงบี๊บ': 'Beep sound',
    'แตะเพื่อฟังตัวอย่างแล้วเลือกทันที — เสียงนี้ใช้เฉพาะตอนยิงแท็ก RFID เท่านั้น ไม่มีผลกับเสียงอื่นของเครื่อง (เช่น เสียงยิงบาร์โค้ด)':
        "Tap to preview and pick instantly — this sound only applies when reading RFID tags, it has no effect on the device's other sounds (like the barcode scan beep)",
  };
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
