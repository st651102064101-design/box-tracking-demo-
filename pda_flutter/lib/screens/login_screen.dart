import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _manual = TextEditingController();

  @override
  void dispose() {
    _manual.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final top = MediaQuery.of(context).padding.top;
    final bottom = MediaQuery.of(context).padding.bottom;

    final emps = c.employees;
    final items = emps.isEmpty
        ? [
            {'name': 'demo (ผู้ทดสอบ)', 'sub': 'บัญชีเริ่มต้น', 'initials': 'd', 'pick': 'demo'}
          ]
        : emps
            .map((e) => {
                  'name': (e['name'] ?? '').toString(),
                  'sub': '${e['role'] ?? 'พนักงาน'}${e['dept'] != null ? ' · ${e['dept']}' : ''}',
                  'initials': (e['name'] ?? '?').toString().trim().isEmpty
                      ? '?'
                      : (e['name']).toString().trim().substring(0, 1),
                  'pick': (e['name'] ?? '').toString(),
                })
            .toList();

    return Column(
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(22, top + 30, 22, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: const [
                  BrandMark(size: 42),
                  SizedBox(width: 11),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Wordmark(),
                      Text('เข้าสู่ระบบก่อนเริ่มกะ', style: TextStyle(fontSize: 12, color: C.muted)),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 22),
              const Text('เลือกพนักงาน\nผู้ปฏิบัติงาน',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700, letterSpacing: -0.6, height: 1.15)),
              const SizedBox(height: 6),
              const Text('ทุกการยิงเข้า–ออกจะบันทึกในชื่อผู้ที่ล็อกอิน',
                  style: TextStyle(fontSize: 13.5, color: C.muted)),
            ],
          ),
        ),
        if (!c.connected)
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 6, 22, 0),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
              decoration: BoxDecoration(
                color: C.orangeBg,
                borderRadius: BorderRadius.circular(15),
                border: Border.all(color: C.orangeBorder),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    c.connError == null
                        ? 'ยังไม่พบข้อมูลจากระบบหลัก BoxTrace — แตะปุ่มด้านล่างเพื่อใส่ข้อมูลตัวอย่าง หรือตั้งค่าการเชื่อมต่อ'
                        : 'เชื่อมต่อไม่ได้: ${c.connError}',
                    style: const TextStyle(fontSize: 13, color: C.orange, fontWeight: FontWeight.w600, height: 1.45),
                  ),
                  const SizedBox(height: 9),
                  Wrap(
                    spacing: 9,
                    runSpacing: 9,
                    children: [
                      _smallSolid('ใส่ข้อมูลตัวอย่าง (เดโม)', c.busy ? null : c.doSeed),
                      _smallOutline('ตั้งค่าการเชื่อมต่อ', () => c.go(Screen.settings)),
                    ],
                  ),
                ],
              ),
            ),
          ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(22, 18, 22, bottom + 20),
            children: [
              ...items.map((e) => Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _EmployeeTile(
                      name: e['name']!,
                      sub: e['sub']!,
                      initials: e['initials']!,
                      onTap: () => c.pickEmp(e['pick']!),
                    ),
                  )),
              Container(
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.only(top: 16),
                decoration: const BoxDecoration(border: Border(top: BorderSide(color: C.border))),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('หรือพิมพ์ชื่อผู้ปฏิบัติงาน',
                        style: TextStyle(fontSize: 12, color: C.muted, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _manual,
                            onChanged: c.setManualName,
                            onSubmitted: (_) => c.doManualLogin(),
                            decoration: _inputDecoration('ชื่อ–สกุล'),
                          ),
                        ),
                        const SizedBox(width: 9),
                        SizedBox(
                          height: 48,
                          child: FilledButton(
                            onPressed: c.doManualLogin,
                            style: FilledButton.styleFrom(
                              backgroundColor: C.ink,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
                              padding: const EdgeInsets.symmetric(horizontal: 20),
                            ),
                            child: const Text('เข้า', style: TextStyle(fontWeight: FontWeight.w600)),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _smallSolid(String label, VoidCallback? onTap) => FilledButton(
        onPressed: onTap,
        style: FilledButton.styleFrom(
          backgroundColor: C.orange,
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        ),
        child: Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
      );

  Widget _smallOutline(String label, VoidCallback onTap) => OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          foregroundColor: C.orange,
          side: const BorderSide(color: C.orangeBorder),
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        ),
        child: Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
      );
}

InputDecoration _inputDecoration(String hint) => InputDecoration(
      hintText: hint,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      filled: true,
      fillColor: C.surface,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(13),
        borderSide: const BorderSide(color: C.border2, width: 1.5),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(13),
        borderSide: const BorderSide(color: C.border2, width: 1.5),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(13),
        borderSide: const BorderSide(color: C.ink, width: 1.5),
      ),
    );

class _EmployeeTile extends StatelessWidget {
  final String name, sub, initials;
  final VoidCallback onTap;
  const _EmployeeTile({required this.name, required this.sub, required this.initials, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: C.border),
            boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 2, offset: const Offset(0, 1))],
          ),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: const BoxDecoration(color: C.neutralBg, shape: BoxShape.circle),
                alignment: Alignment.center,
                child: Text(initials,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: C.ink2)),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: C.ink)),
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
