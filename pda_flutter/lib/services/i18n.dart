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
    'ไม่มีเครื่องอ่าน RFID ในตัวเครื่อง — ใช้บาร์โค้ดได้ตามปกติ':
        'No integrated RFID reader — barcode still works normally',
    'ตรวจไม่พบเครื่องอ่าน RFID ในตัวเครื่องนี้ — ฟังก์ชันบาร์โค้ดยังใช้งานได้ตามปกติ':
        'No RFID reader detected on this device — barcode features still work normally',
    'อุปกรณ์นี้': 'This device',

    // shared
    'เข้า': 'In',
    'ออก': 'Out',
    'โซน': 'Zone',
    'วันนี้': 'Today',
    'ออนไลน์': 'Online',
    'ออฟไลน์': 'Offline',
    'ไม่มีกล่อง': 'No boxes',

    // home screen
    'ยังไม่ได้เชื่อมข้อมูลกับระบบหลัก — ไปที่ตั้งค่าเพื่อเชื่อมต่อ หรือใส่ข้อมูลตัวอย่าง':
        'Not yet connected to the main system — go to Settings to connect, or load sample data',
    'ยังไม่มีคลังในระบบ — ไปเพิ่มคลังที่ระบบหลักก่อน':
        'No warehouses in the system yet — add one in the main system first',
    'เลือกคลัง': 'Choose warehouse',
    'ล่าสุด': 'Last used',
    'เลือกประตู': 'Choose gate',
    'เปลี่ยนคลัง': 'Change warehouse',
    'ในคลัง': 'In warehouse',
    'กล่องในคลัง': 'Boxes in warehouse',
    'ออกอยู่': 'Out',
    'กล่องที่ออกอยู่': 'Boxes out',
    'คุณประจำ': 'You are based at',
    '— รายการที่ยิงจะบันทึกที่': '— scans here will be recorded at',
    'บัญชีนี้เป็นสิทธิ์ผู้ชม — ค้นหากล่องได้ แต่บันทึกเข้า/ออกไม่ได้':
        'This account is view-only — you can search boxes, but not record in/out',
    'งานหลัก': 'Main tasks',
    'ลงทะเบียนกล่อง': 'Register box',
    'รับกล่องจาก supplier — สร้างกล่อง ติดป้าย ผูกแท็ก แล้ว Putaway':
        'Receive boxes from a supplier — create, label, tag, then put away',
    'รับเข้า / รับคืน': 'Gate In / Return',
    'Gate In — ยิงกล่องกลับเข้าคลัง':
        'Gate In — scan boxes back into the warehouse',
    'ส่งออก': 'Gate Out',
    'Gate Out — จ่ายกล่องออกให้ลูกค้า':
        'Gate Out — release boxes to a customer',
    'ลงทะเบียนแท็ก RFID': 'Register RFID tag',
    'สแกนบาร์โค้ด แล้วยิงแท็กเพื่อผูกกับกล่องนั้นทันที':
        'Scan a barcode, then scan a tag to link it right away',
    'หากล่อง / RFID': 'Find box / RFID',
    'เลือกกล่อง แล้วกวาดหาสัญญาณแบบ Geiger':
        'Pick a box, then sweep for its signal like a Geiger counter',
    'ค้นหา / ตรวจสอบกล่อง': 'Search / check box',
    'Track — ดูสถานะ ตำแหน่ง ประวัติ': 'Track — status, location, history',
    'ยังไม่มีรายการวันนี้': 'Nothing recorded today yet',
    'เปลี่ยนคน / จบงาน': 'Switch person / end shift',
    'กลับไปหน้ายิงบัตร — เครื่องยังประจำประตูเดิม':
        'Back to the badge screen — the terminal stays at the same gate',
    'เปลี่ยนคลัง/ประตู': 'Change warehouse/gate',
    'เลือกจุดทำงานใหม่สำหรับกะนี้': 'Pick a new work post for this shift',
    'รายการค้าง sync (ออฟไลน์) — จะส่งเข้าระบบเมื่อกลับมาออนไลน์':
        'Items waiting to sync (offline) — will send once back online',

    // track screen
    'ยิงหรือพิมพ์รหัสกล่อง': 'Scan or type a box code',
    'รหัสกล่อง เช่น CRT-01': 'Box code, e.g. CRT-01',
    'เหนี่ยวไกเพื่ออ่านแท็ก RFID': 'Pull the trigger to read an RFID tag',
    'พบ': 'Found',
    'แท็ก': 'tags',
    'ไม่พบกล่อง': 'Box',
    'ในระบบ': 'not found in the system',
    'บาร์โค้ด': 'Barcode',
    'ไม่พบกล่องนี้ในระบบ': 'This box is not in the system',
    'ลูกค้า / DO': 'Customer / DO',
    'สูญหายกับ': 'Lost with',
    'ตำแหน่ง': 'Location',
    'รอจัดเก็บ': 'Awaiting putaway',
    'รอบหมุนเวียน': 'Cycles',
    'รอบ': 'cycles',
    'เห็นล่าสุด': 'Last seen',
    'ประวัติล่าสุด': 'Recent history',
    'รับเข้าครั้งแรก': 'First received at',
    'รับคืนเข้า': 'Returned to',
    'ตีเป็นสูญหาย': 'Marked lost',
    'ย้ายตำแหน่ง': 'Put away',
    'ลงทะเบียน': 'Registered',
    'โดย': 'by',

    // rfid locate screen
    'ตั้งระยะยิงสูงสุด': 'Range set to maximum',
    'ระบบตั้งกำลังส่งสัญญาณของเครื่องอ่านไว้ที่ระยะไกลสุดโดยอัตโนมัติ '
            'เพื่อให้กวาดหากล่องได้ไกลที่สุดเท่าที่เครื่องรองรับ':
        'The system automatically set the reader\'s transmit power to its maximum, '
            'so the sweep can reach as far as this reader supports',
    'เข้าใจแล้ว': 'Got it',
    'ไม่ต้องแสดงอีก': 'Don\'t show again',
    'เจอ': 'Found',
    'เลือกกล่องที่จะหา': 'Pick a box to find',
    'กวาดหาสัญญาณ': 'Sweeping for a signal',
    'ยิงบาร์โค้ดกล่องที่จะหา': 'Scan the box you want to find',
    'หรือเลือกจากรายการ': 'Or pick from the list',
    'ยังไม่มีกล่องที่ผูกแท็ก RFID ในระบบ': 'No box has an RFID tag linked yet',
    'ไม่พบกล่องรหัส': 'No box with code',
    'ยังไม่ได้ผูกแท็ก RFID — หาไม่ได้':
        'No RFID tag linked yet — cannot be located',
    'เหนี่ยวไกยิงแท็กของกล่องที่จะหา':
        'Pull the trigger on the box\'s tag to find it',
    'ยังไม่ได้ผูกแท็ก RFID': 'No RFID tag linked yet',
    'เปลี่ยนกล่อง': 'Change box',
    'ใช้ได้เฉพาะบนเครื่องอ่าน Zebra': 'Only works on a Zebra reader',
    'กำลังกวาดหา…': 'Sweeping…',
    'พร้อม — กดหรือเหนี่ยวไกเพื่อเริ่ม':
        'Ready — tap or pull the trigger to start',
    'ยังไม่ได้เชื่อมต่อ': 'Not connected',
    'ไม่พบสัญญาณ': 'No signal',
    'พบกล่องแล้ว — อยู่ใกล้มาก': 'Found it — very close',
    'ใกล้แล้ว — เดินตามสัญญาณต่อ': 'Getting close — keep following the signal',
    'กำลังมาถูกทาง': 'Getting warmer',
    'ยังไกล — ลองเดินไปทางอื่น': 'Still far — try another direction',
    'เหนี่ยวไกแล้วเดินกวาดไปเรื่อยๆ สัญญาณจะแรงขึ้นเมื่อเข้าใกล้':
        'Pull the trigger and walk around — the signal gets stronger the closer you get',
    'อ่านพบแล้ว': 'read',
    'ครั้ง': 'times',
    'หยุดกวาด': 'Stop sweeping',
    'เริ่มกวาดหา': 'Start sweeping',
    'ระบบบันทึกตำแหน่งล่าสุดว่า': 'Last recorded location:',
    '— ใช้เป็นจุดเริ่มเดินกวาด '
            'แล้วสังเกตมิเตอร์ด้านบนเพื่อยืนยันว่ากล่องอยู่ในโซนนี้จริง':
        '— use it as a starting point and watch the meter above to confirm the box is really in this zone',
    'ออกอยู่กับ': 'Out with',
    'แจ้งสูญหาย': 'Reported lost',

    // settings screen
    'ตั้งค่า': 'Settings',
    'เชื่อมต่อกับ BoxTrace แล้ว': 'Connected to BoxTrace',
    'กล่องในฐานข้อมูล': 'boxes in the database',
    'แตะเพื่อเชื่อมต่อใหม่': 'Tap to reconnect',
    'รับค่า RFID': 'RFID readout',
    'อ่านแท็กสด ๆ แบบไม่ผูกกับกล่อง — ดูความเร็วอ่านได้ที่นี่':
        'Read raw tags without linking to a box — check read speed here',
    'เซิร์ฟเวอร์ + บัญชีเครื่อง': 'Server + device account',
    'เฉพาะหัวหน้างาน — เครื่องนี้ประจำ':
        'Supervisor only — this terminal is stationed at',
    'รหัส PIN ส่วนตัว': 'Your PIN',
    'ตั้งไว้แล้ว — แตะเพื่อเปลี่ยนรหัส': 'Already set — tap to change it',
    'ยังไม่ได้ตั้ง — แตะเพื่อตั้งรหัสกันคนอื่นแตะชื่อคุณ':
        'Not set yet — tap to set one and keep others from tapping your name',
    'กลับไปหน้ายิงบัตร': 'Back to the badge screen',
    'เชื่อมกับ BoxTrace backend': 'Connects to the BoxTrace backend',
    'ใส่รหัส PIN เดิมของ': 'Enter the current PIN for',
    'ยืนยันตัวตนก่อนตั้งรหัสใหม่':
        'Verify your identity before setting a new PIN',
    'รหัสไม่ถูกต้อง ลองใหม่': 'Wrong PIN, try again',
    'ออฟไลน์ และยังไม่เคยยืนยันรหัสนี้บนเครื่องนี้ตอนออนไลน์มาก่อน':
        'Offline, and this PIN was never confirmed on this device while online',
    'ขอรหัส OTP ไม่สำเร็จ': 'Failed to request an OTP',
    'ตั้งรหัส PIN ใหม่สำหรับ': 'Set a new PIN for',
    'ตั้งรหัส PIN สำหรับ': 'Set a PIN for',
    'ตั้งรหัส 4 หลักไว้กันคนอื่นแตะชื่อคุณเข้าใช้งาน':
        'Set a 4-digit PIN to stop others from tapping your name in',
    'ยืนยันรหัส PIN อีกครั้ง': 'Confirm the PIN again',
    'พิมพ์รหัส 4 หลักเดิมอีกครั้งเพื่อยืนยัน':
        'Type the same 4-digit PIN again to confirm',
    'รหัสไม่ตรงกัน ลองใหม่': 'PINs don\'t match, try again',
    'ตั้งรหัส PIN ไม่สำเร็จ': 'Failed to set PIN',
    'ตั้งรหัส PIN แล้ว': 'PIN set',
    'ส่งรหัส OTP แล้ว': 'OTP sent',
    'ส่งไปที่อีเมล': 'Sent to email',
    'แล้ว — กรอกรหัส 6 หลักด้านล่าง': '— enter the 6-digit code below',
    'เช็คอีเมลของคุณแล้วกรอกรหัส 6 หลักด้านล่าง':
        'Check your email and enter the 6-digit code below',
    'กรอกรหัส OTP': 'Enter the OTP',
    'ส่งไปที่': 'Sent to',
    '(มีอายุ 5 นาที)': '(valid for 5 minutes)',
    'รหัส 6 หลักที่ส่งไปทางอีเมล (มีอายุ 5 นาที)':
        'The 6-digit code sent by email (valid for 5 minutes)',
    'รีเซ็ต PIN ไม่สำเร็จ': 'Failed to reset PIN',
    'ตั้งรหัส PIN ใหม่แล้ว': 'New PIN set',
    'เครื่องอ่าน RFID (Zebra)': 'RFID reader (Zebra)',
    'ใช้ได้เฉพาะบนเครื่อง Android ที่มีเครื่องอ่าน Zebra':
        'Only works on an Android device with a Zebra reader',
    'เชื่อมต่อเครื่องอ่านแล้ว': 'Reader connected',
    'เชื่อมต่อไม่สำเร็จ': 'Connection failed',
    'ตัดการเชื่อมต่อ': 'Disconnected',
    'เชื่อมต่อใหม่': 'Reconnect',
    'ระยะยิงแท็ก': 'Tag range',
    'กำลังยิงทดสอบ… ปล่อยนิ้วเพื่อหยุด': 'Test firing… release to stop',
    'กดค้างเพื่อทดสอบยิง': 'Hold to test fire',
    'เชื่อมต่อเครื่องอ่านก่อน เพื่อปรับระยะยิงแบบละเอียดเต็มสเปกของเครื่องนี้':
        'Connect the reader first to fine-tune the range across this reader\'s full spec',
    'กรองสัญญาณอ่อน (RSSI)': 'Filter weak signals (RSSI)',
    'ตัดทิ้งแท็กที่อ่านได้อ่อนกว่าค่าที่ตั้ง — กันอ่านทะลุไปโดนพาเลทข้างๆ':
        'Drop tags read weaker than the set value — keeps a sweep from picking up the next pallet over',
    'เสียงเมื่อเจอแท็ก RFID': 'Sound on RFID tag detection',
    'แตะเพื่อฟังตัวอย่างแล้วเลือกทันที': 'Tap to preview and select instantly',
    'เสียงตอนอ่าน RFID': 'RFID read sound',
    'บนเบราว์เซอร์/เดสก์ท็อปจะไม่มีเครื่องอ่าน — ใช้ช่องพิมพ์รหัสแทนได้ '
            'รายละเอียดด้านล่างจะขึ้นเมื่อรันบนเครื่องจริง':
        'No reader on browser/desktop — use the type-in field instead. '
            'Details below appear when running on real hardware',
    'รุ่นเครื่องอ่าน': 'Reader model',
    'ชื่ออุปกรณ์': 'Device name',
    'หมายเลขเครื่อง': 'Serial number',
    'เฟิร์มแวร์': 'Firmware',
    'ภูมิภาค (Region)': 'Region',
    'ช่องทางเชื่อมต่อ': 'Transport',
    'กำลังส่ง (index)': 'Transmit power (index)',
    'แท็กที่อ่านได้สะสม': 'Total tags read',
    'EPC ล่าสุด': 'Last EPC',
    'RSSI ล่าสุด': 'Last RSSI',
    'ข้อผิดพลาดล่าสุด': 'Last error',
    'ทดสอบ: เหนี่ยวไกค้างไว้ 5 วินาทีใกล้กล่องที่ติดแท็ก — ถ้าตัวเลข '
            '"แท็กที่อ่านได้สะสม" เดินขึ้น แปลว่าเครื่องอ่านทำงานครบวงจรแล้ว':
        'Test: hold the trigger for 5 seconds near a tagged box — if the '
            '"Total tags read" number climbs, the reader is fully working',
    'หลวม · รับเกือบทุกแท็ก': 'Loose · accepts nearly every tag',
    'ปานกลาง': 'Medium',
    'เข้ม · เฉพาะแท็กใกล้มาก': 'Tight · only very close tags',
    'ใกล้ · ~30 ซม.': 'Near · ~30 cm',
    'ปานกลาง · ~1-2 ม.': 'Medium · ~1-2 m',
    'ไกล · สุดกำลังเครื่อง': 'Far · full reader power',

    // home menu (6 primary actions) + the screens behind them
    'จ่ายออก': 'Gate Out',
    'รับเข้า': 'Gate In',
    'ตรวจนับ': 'Cycle Count',
    'ค้นหา/เรดาร์': 'Search / Radar',
    'ผูก Tag / ชำรุด / อื่นๆ': 'Tag / Damage / More',
    // transfer screen
    'ยิงหรือพิมพ์รหัสกล่องที่จะย้าย': 'Scan or type the box code to move',
    'ตำแหน่งใหม่': 'New location',
    'ยืนยันย้ายตำแหน่ง': 'Confirm transfer',
    'แร็ค': 'Rack',
    'ชั้น': 'Shelf',
    'ช่อง': 'Slot',
    'กำลังบันทึก…': 'Saving…',
    // cycle count screen
    'เลือกโซนที่จะตรวจนับ': 'Choose a zone to count',
    'ทั้งคลัง': 'Whole warehouse',
    'คาดว่ามี': 'Expected',
    'พบแล้ว': 'Counted',
    'ยังไม่พบ': 'Missing',
    'ไม่ควรอยู่ที่นี่': 'Unexpected here',
    'เริ่มตรวจนับ': 'Start count',
    'กำลังเริ่ม…': 'Starting…',
    'รอบตรวจนับจะถูกบันทึกลงระบบ — ถ้ามีคนเริ่มรอบของโซนนี้ค้างไว้ ระบบจะทำต่อรอบเดิมให้':
        'The count is recorded on the server — if someone already has a count open for this zone, you\'ll continue theirs',
    'ปิดรอบและบันทึกผล': 'Close and save result',
    'ปิดรอบตรวจนับ': 'Close this count?',
    'ปิดรอบแล้วจะบันทึกผลลงระบบ และเพิ่มสแกนอีกไม่ได้':
        'Closing saves the result and no more scans can be added',
    'ปิดรอบ': 'Close',
    'ยกเลิก': 'Cancel',
    'รอส่งเข้าระบบ': 'Waiting to send',

    // transfer screen
    'เหนี่ยวไกเพื่อกวาดหลายกล่องพร้อมกัน':
        'Pull the trigger to sweep several boxes at once',
    'หลายกล่อง': 'multiple',
    'เลือกกล่องจากรายการ': 'Choose a box from the list',
    'ยิงบาร์โค้ดแทน': 'Scan a barcode instead',
    'เลือกจากรายการแทน': 'Choose from a list instead',
    'พิมพ์รหัสหรือประเภทกล่อง': 'Type a code or box type',
    'ยังไม่พบกล่อง — เหนี่ยวไกกวาดเหนือกองกล่องที่จะย้าย':
        'No boxes found yet — pull the trigger and sweep over the pile to move',
    'เลือกย้าย': 'selected',
    'ล้างรายการ': 'Clear list',
    'ตำแหน่งใหม่ (ทั้งหมด)': 'New location (all)',
    'ย้ายทั้งหมด': 'Move all',
    'เพิ่ม': 'Add',
    // more hub
    'ผูกแท็ก RFID': 'Bind RFID tag',
    'ลงทะเบียนกล่องใหม่': 'Register a new box',
    'แจ้งกล่องชำรุด — ทำได้ตอนรับเข้า (Gate In): ติ๊กสถานะ "ชำรุด" ที่การ์ดกล่องนั้นในคิวก่อนยืนยัน':
        'Flagging a box damaged is done at Gate In: tick "Damaged" on that box\'s card in the queue before confirming',
    // pin reset
    'รหัส OTP ไม่ถูกต้องหรือหมดอายุ': 'OTP is incorrect or has expired',

    // scan (gate) screen
    'กลับไปสแกนกล่องเพิ่ม': 'Back to scan more boxes',
    'แก้ไขข้อมูลลูกค้า/รถ': 'Edit customer/vehicle info',
    'ถัดไป': 'Next',
    'ยืนยันส่งออก': 'Confirm Gate Out',
    'ยืนยันรับเข้าคลัง': 'Confirm Gate In',
    'ลูกค้าปลายทาง *': 'Destination customer *',
    '— เลือกลูกค้า —': '— Choose customer —',
    'ทะเบียนรถ *': 'License plate *',
    'ทะเบียนรถ': 'License plate',
    'คนขับ': 'Driver',
    'ชื่อคนขับ': 'Driver name',
    'ประเภทรถ': 'Vehicle type',
    '— เลือกประเภทรถ —': '— Choose vehicle type —',
    'ระบุประเภทรถ *': 'Specify vehicle type *',
    'เช่น รถตู้ / รถพ่วง': 'e.g. Van / Trailer',
    'เลขที่ DO/PO จะสร้างอัตโนมัติเมื่อยืนยันส่งออก':
        'DO/PO number is generated automatically on confirming Gate Out',
    'รถกระบะ': 'Pickup truck',
    'รถบรรทุก 6 ล้อ': '6-wheel truck',
    'รถบรรทุก 10 ล้อ': '10-wheel truck',
    'รถเทรลเลอร์': 'Trailer',
    'อื่นๆ': 'Other',
    'กำลังอ่านแท็ก RFID…': 'Reading RFID tags…',
    'โหมดจำลอง': 'Simulated mode',
    'สแกนเนอร์พร้อม': 'Scanner ready',
    'สแกนเนอร์ไม่พร้อม': 'Scanner not ready',
    'ยิงบาร์โค้ด หรือพิมพ์รหัส': 'Scan a barcode, or type a code',
    'คิวสแกน': 'Scan queue',
    'ใบ': 'boxes',
    'ล้างคิว': 'Clear queue',
    'ยังไม่มีกล่องในคิว — เหนี่ยวไกหรือยิงบาร์โค้ดเพื่อเริ่ม':
        'No boxes in the queue yet — pull the trigger or scan a barcode to start',
    'เหนี่ยวไกอ่าน RFID · หรือยิงบาร์โค้ด':
        'Pull the trigger for RFID · or scan a barcode',
    'คืน': 'Return',
    'ใหม่': 'New',
    'พร้อมจ่าย': 'Ready to ship',
    'ปกติ': 'Normal',
    'ชำรุด': 'Damaged',
    'พัก (Hold)': 'Hold',

    // gate in: where the batch lands
    'เก็บที่ไหน': 'Store where',
    'ตามระบบแนะนำ': 'System-suggested',
    'เลือกเอง': 'Pick manually',
    'ช่องว่าง': 'Empty bin',
    'รอ Putaway': 'Pending putaway',
    'ตัวเลือกอื่น': 'Other options',
    'ซ่อน': 'Hide',
    'จะรับเข้าไว้ในคลังก่อน — ยังไม่ระบุตำแหน่งจัดเก็บ':
        'Will be received into the warehouse first — no shelf decided yet',
    'อยู่ในคลังนี้ก็พอ — ไม่ต้องระบุตำแหน่งตอนนี้':
        'Just needs to be in this warehouse — no location required right now',
    'กำลังหาชั้นวางว่าง…': 'Finding an empty shelf…',
    'คลังนี้ยังไม่ได้ตั้งค่าผังชั้นวาง — จะเก็บไว้รอ Putaway แทน':
        'No shelf layout set up for this warehouse yet — will stay pending putaway',
    'ชั้นวางที่ตั้งค่าไว้ถูกใช้ครบแล้ว — จะเก็บไว้รอ Putaway แทน':
        'Every set-up shelf is already taken — will stay pending putaway',
    'ลองใหม่': 'Retry',

    // putaway step (after a Gate In commit in auto/manual mode)
    'Putaway': 'Putaway',
    'นำไปเก็บเข้าชั้น': 'Put away on the shelf',
    'ระบบจะกำหนดชั้นวางให้หลังยิงกล่องครบ แล้วพาไปเก็บทีละจุด':
        'The system assigns a shelf once the boxes are scanned, then walks you there',
    'ยิงกล่องให้ครบก่อน แล้วค่อยเดินไปหาช่องว่างและยิงบาร์โค้ดชั้นวางเอง':
        'Scan the boxes first, then find a free spot and scan that shelf yourself',
    'รับเข้าอย่างเดียว — พักไว้ให้คนจัดเก็บมาเอาขึ้นชั้นทีหลัง':
        'Receive only — left for someone to shelve later',
    'นำสินค้าไปเก็บที่': 'Take these to',
    'กล่องที่สแกน': 'Boxes scanned',
    'ตำแหน่งแร็ค': 'Rack location',
    'รอการสแกน…': 'Waiting for a scan…',
    'เดินไปที่ช่องนี้ แล้วยิงบาร์โค้ดชั้นวางเพื่อบันทึกทันที':
        'Walk to this bay and scan its shelf barcode — that saves it right away',
    'หาช่องว่าง แล้วยิงบาร์โค้ดชั้นวาง — ระบบจะบันทึกให้ทันที':
        'Find a free bay and scan its shelf barcode — it saves right away',
    'สำเร็จ!': 'Done!',
    'เก็บเข้าชั้นแล้ว': 'Shelved',
    'ยิงบาร์โค้ดชั้นวางเท่านั้น': 'Shelf barcode only',
    'ขั้นตอนเก็บเข้าชั้นไม่รับ RFID': 'The putaway step does not accept RFID',
    'หาช่องว่าง แล้วยิงบาร์โค้ดชั้นวางที่เก็บ':
        'Find a free spot, then scan that shelf\'s barcode',
    'ยิงบาร์โค้ดชั้นวางเพื่อยืนยันว่ามาถูกช่อง':
        'Scan the shelf barcode to confirm you are at the right one',
    'ยิงบาร์โค้ดชั้นวาง': 'Scan the shelf barcode',
    'ยิงบาร์โค้ดของชั้นวางที่จะนำกล่องไปวาง':
        'Scan the barcode of the shelf you are putting the box on',
    'ยิงใหม่': 'Rescan',
    'ทั้งชุดไปที่ช่องเดียวกัน — ถ้าคนละช่อง ให้กวาดแยกทีละช่อง':
        'The whole batch goes to one spot — sweep separately for separate spots',
    'ไม่พบตำแหน่งรหัส': 'No location with code',
    'ผิดช่อง — ระบบกำหนดให้เก็บที่': 'Wrong shelf — the system assigned',
    'ยืนยันช่องแล้ว': 'Shelf confirmed',
    'ยืนยันเก็บเข้าชั้น': 'Confirm put away',
    'เก็บไม่สำเร็จ': 'Failed to put away',
    'ยังไม่เก็บตอนนี้ — พักไว้ก่อน': 'Not now — leave it pending',
    'ยังไม่เก็บเข้าชั้น?': 'Leave it unshelved?',
    'กล่องรับเข้าเรียบร้อยแล้ว แต่จะค้างสถานะ "รอจัดเก็บ" จนกว่าจะมีคนนำไปขึ้นชั้น':
        'The boxes are received, but stay "awaiting putaway" until someone shelves them',
    'เก็บต่อ': 'Keep going',
    'พักไว้ก่อน': 'Leave it pending',

    // more hub: hold/release, report problem, location inquiry
    'พัก / แจ้งชำรุด': 'Hold / flag damage',
    'กล่องที่อยู่ในคลังแล้ว — ชำรุดทีหลัง, พักรอ QC, หรือปลดพัก':
        'A box already in the warehouse — damaged later, held for QC, or released',
    'แจ้งปัญหาหน้างาน': 'Report a floor problem',
    'ของหาย / ช่องเก็บเต็ม': 'Missing box / bin full',
    'เช็คช่อง': 'Check a bin',
    'ยิงบาร์โค้ดชั้นวาง ดูว่าควรมีอะไรอยู่':
        'Scan a shelf barcode to see what should be there',
    'ยิงบาร์โค้ดกล่องที่จะพักหรือแจ้งชำรุด':
        'Scan the box to hold or flag as damaged',
    'เลือกการทำงาน': 'Choose an action',
    'เหตุผล (ถ้ามี)': 'Reason (optional)',
    'เช่น มุมยุบ / รอตรวจสอบ QC': 'e.g. dented corner / pending QC',
    'พักสินค้า (Hold)': 'Hold',
    'แจ้งชำรุด': 'Flag as damaged',
    'ปลดพัก — กลับเป็นปกติ': 'Release — back to normal',
    'ของหาย': 'Missing box',
    'ยิงบาร์โค้ดกล่อง — ระบบสั่งมาที่นี่แต่ไม่พบของ':
        'Scan the box — the system sent you here but nothing was found',
    'ช่องเก็บเต็ม': 'Bin full',
    'ยิงบาร์โค้ดชั้นวาง — ช่องที่ระบบแนะนำเต็มแล้วจริง':
        'Scan the shelf — the suggested bin is genuinely full',
    'ยิงบาร์โค้ดกล่องที่หา': 'Scan the box you\'re reporting',
    'ยิงบาร์โค้ดชั้นวางที่เต็ม': 'Scan the full shelf',
    'รายละเอียดเพิ่มเติม (ถ้ามี)': 'More detail (optional)',
    'เช่น หาในโซนใกล้เคียงแล้วไม่พบ':
        'e.g. checked nearby zones too, still not found',
    'เช่น มีของวางเกินที่ระบบบันทึกไว้':
        'e.g. more sitting here than the system has on record',
    'ส่งรายงาน': 'Send report',
    'บันทึกรายงานแล้ว': 'Report recorded',
    'แจ้งอีกรายการ': 'Report another',
    'กลับหน้าหลัก': 'Back to home',
    'ยิงบาร์โค้ดชั้นวางเพื่อดูของที่ควรอยู่':
        'Scan a shelf barcode to see what belongs there',
    'ระบบบันทึกว่ามี': 'The system has',
    'ใบที่นี่': 'box(es) recorded here',
    'ระบบไม่พบกล่องบันทึกไว้ที่ช่องนี้': 'No box is recorded at this bin',
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
                child:
                    Text('|', style: TextStyle(fontSize: 12, color: C.chevron)),
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
