import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _url;
  late final TextEditingController _user;
  late final TextEditingController _pass;

  @override
  void initState() {
    super.initState();
    final c = context.read<AppController>();
    _url = TextEditingController(text: c.prefs.baseUrl);
    _user = TextEditingController(text: c.prefs.username);
    _pass = TextEditingController(text: c.prefs.password);
  }

  @override
  void dispose() {
    _url.dispose();
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;

    return Column(
      children: [
        StickyHeader(onBack: c.backToHome, title: const Text('ตั้งค่า / การเชื่อมต่อ')),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 16, 16, bottom + 16),
            children: [
              // connection panel
              Panel(
                padding: const EdgeInsets.all(16),
                radius: 18,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Caption('การเชื่อมต่อระบบหลัก'),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Container(
                          width: 11,
                          height: 11,
                          decoration: BoxDecoration(
                            color: c.connected ? C.lime : C.red,
                            shape: BoxShape.circle,
                            boxShadow: [
                              BoxShadow(color: c.connected ? C.limeBg : C.redBg, spreadRadius: 3)
                            ],
                          ),
                        ),
                        const SizedBox(width: 11),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                c.connected ? 'เชื่อมต่อกับ BoxTrace แล้ว' : (c.connError ?? 'ยังไม่พบข้อมูล'),
                                style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                              ),
                              Text('พบ ${c.boxCount} กล่องในฐานข้อมูล',
                                  style: const TextStyle(fontSize: 12, color: C.muted)),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    const FieldLabel('API Base URL'),
                    TextField(
                      controller: _url,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      decoration: pdaInput('http://192.168.1.10:4000'),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const FieldLabel('ผู้ใช้'),
                              TextField(controller: _user, autocorrect: false, decoration: pdaInput('admin')),
                            ],
                          ),
                        ),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const FieldLabel('รหัสผ่าน'),
                              TextField(controller: _pass, obscureText: true, decoration: pdaInput('••••••')),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    PrimaryButton(
                      label: c.busy ? 'กำลังเชื่อมต่อ…' : 'บันทึก & เชื่อมต่อ',
                      onTap: c.busy
                          ? null
                          : () => c.applyConnection(
                                baseUrl: _url.text,
                                username: _user.text,
                                password: _pass.text,
                              ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Emulator ใช้ 10.0.2.2 · เครื่องจริงใช้ IP ของเครื่องที่รัน backend (พอร์ต 4000)',
                      style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.4),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              // RFID reader panel
              Panel(
                padding: const EdgeInsets.all(16),
                radius: 18,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Caption('เครื่องอ่าน RFID (Zebra)'),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Container(
                          width: 11,
                          height: 11,
                          decoration: BoxDecoration(
                            color: _rfidColor(c.rfidStatus.state),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 11),
                        Expanded(
                          child: Text(
                            _rfidLabel(c),
                            style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                          ),
                        ),
                        OutlinedButton(
                          onPressed: () => c.rfid.connect(),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: C.ink,
                            side: const BorderSide(color: C.border2),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
                          ),
                          child: const Text('เชื่อมต่อใหม่'),
                        ),
                      ],
                    ),
                    if (c.rfidStatus.message.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(c.rfidStatus.message, style: const TextStyle(fontSize: 12, color: C.muted)),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              // actions
              _tile(
                icon: Icons.badge_outlined,
                title: 'แก้ไขกะ / ประตู',
                sub: '${c.selWhName} · ประตู ${c.gate}',
                onTap: c.goSessionEdit,
              ),
              const SizedBox(height: 10),
              _tile(
                icon: Icons.dataset_outlined,
                title: 'โหลดข้อมูลตัวอย่าง (เดโม)',
                sub: '15 กล่อง · 4 พนักงาน · 4 คลัง → เขียนลงฐานข้อมูล',
                onTap: c.busy ? null : c.doSeed,
              ),
              const SizedBox(height: 10),
              _tile(
                icon: Icons.logout,
                title: 'ออกจากระบบ (เปลี่ยนผู้ปฏิบัติงาน)',
                sub: 'กลับไปหน้าเลือกพนักงาน',
                danger: true,
                onTap: c.doLogout,
              ),
              const SizedBox(height: 18),
              const Center(
                child: Text(
                  'BoxTrace PDA · v1.0\nFlutter + Zebra RFIDAPI3 · เชื่อมกับ BoxTrace backend',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.5),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Color _rfidColor(RfidState s) {
    switch (s) {
      case RfidState.connected:
        return C.lime;
      case RfidState.connecting:
        return C.orange;
      case RfidState.error:
        return C.red;
      default:
        return C.border2;
    }
  }

  String _rfidLabel(AppController c) {
    if (!c.rfid.supported) return 'ไม่รองรับบนแพลตฟอร์มนี้ (ใช้โหมดจำลอง)';
    switch (c.rfidStatus.state) {
      case RfidState.connected:
        return 'เชื่อมต่อเครื่องอ่านแล้ว';
      case RfidState.connecting:
        return 'กำลังเชื่อมต่อ…';
      case RfidState.error:
        return 'เชื่อมต่อไม่สำเร็จ';
      case RfidState.disconnected:
        return 'ตัดการเชื่อมต่อ';
      case RfidState.idle:
        return 'ยังไม่ได้เชื่อมต่อ';
    }
  }

  Widget _tile({
    required IconData icon,
    required String title,
    required String sub,
    VoidCallback? onTap,
    bool danger = false,
  }) {
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), border: Border.all(color: C.border)),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: danger ? C.redBg : C.neutralBg,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, size: 21, color: danger ? C.red : C.ink2),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title,
                        style: TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w600, color: danger ? C.red : C.ink)),
                    Text(sub,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12.5, color: C.muted)),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: C.chevron, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}
