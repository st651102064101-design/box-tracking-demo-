import 'package:flutter/material.dart';

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
    // login screen
    'เข้าสู่ระบบก่อนเริ่มกะ': 'Sign in before starting a shift',
    'เลือกพนักงาน\nผู้ปฏิบัติงาน': 'Select operator\nemployee',
    'ทุกการยิงเข้า–ออกจะบันทึกในชื่อผู้ที่ล็อกอิน': 'Every in/out scan is logged under the signed-in name',
    'ตั้งค่าการเชื่อมต่อ': 'Connection settings',
    'ยังไม่มีบัญชีพนักงานในระบบ': 'No employee accounts yet',
    'รอเชื่อมต่อกับระบบหลักก่อน': 'Waiting to connect to the main system',
    'ยังไม่พบข้อมูลจากระบบหลัก BoxTrace — แตะปุ่มด้านล่างเพื่อตั้งค่าการเชื่อมต่อ':
        'No data from the BoxTrace main system yet — tap below to set up the connection',
    'เชื่อมต่อไม่ได้': 'Could not connect',
    'ใส่รหัสผ่านเพื่อเข้าสู่ระบบ': 'Enter your password to sign in',
    'รหัสผ่าน': 'Password',
    'ยกเลิก': 'Cancel',
    'เข้าสู่ระบบ': 'Sign in',
    'ผู้ดูแลระบบ': 'Administrator',
    'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง': 'Incorrect username or password',

    // session setup screen
    'ตั้งค่ากะทำงาน': 'Shift setup',
    'ผู้ปฏิบัติงาน': 'Operator',
    '1 · เลือกคลังสินค้า': '1 · Select warehouse',
    'เลือกคลังและประตูก่อน': 'Select a warehouse and gate first',
    'เริ่มกะทำงาน': 'Start shift',
    'เข้า': 'IN',
    'ออก': 'OUT',
    'เข้า/ออก': 'IN/OUT',
    'ประตู': 'Gate',
  };

  /// '2 · เลือกประตู (Gate) — {whName}' has an interpolated warehouse name, so
  /// it can't be a flat dictionary lookup — build it from parts instead.
  String gateStepLabel(String whName) =>
      lang == 'en' ? '2 · Select gate — $whName' : '2 · เลือกประตู (Gate) — $whName';

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
      color: const Color(0xFFEDEDF0),
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
                      color: isEn ? Colors.black38 : Colors.black)),
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 4),
                child: Text('|', style: TextStyle(fontSize: 12, color: Colors.black26)),
              ),
              Text('EN',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: isEn ? FontWeight.w800 : FontWeight.w500,
                      color: isEn ? Colors.black : Colors.black38)),
            ],
          ),
        ),
      ),
    );
  }
}
