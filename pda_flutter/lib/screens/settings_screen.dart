import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/rfid_service.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// In-shift settings: what the operator can see and do without leaving their
/// session. Anything that changes what this terminal *is* — its address, its
/// service account, the gate it serves — lives in device setup instead, behind
/// [AppController.canConfigureDevice].
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final bottom = MediaQuery.of(context).padding.bottom;

    return Column(
      children: [
        StickyHeader(onBack: c.backToHome, title: const Text('ตั้งค่า')),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 16, 16, bottom + 16),
            children: [
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
                                  style: TextStyle(fontSize: 12, color: C.muted)),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Text(c.prefs.baseUrl, style: TextStyle(fontSize: 11.5, color: C.faint)),
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
                            side: BorderSide(color: C.border2),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
                          ),
                          child: const Text('เชื่อมต่อใหม่'),
                        ),
                      ],
                    ),
                    if (c.rfidStatus.message.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(c.rfidStatus.message, style: TextStyle(fontSize: 12, color: C.muted)),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              if (c.canConfigureDevice)
                _tile(
                  icon: Icons.router_outlined,
                  title: 'ตั้งค่าเครื่อง',
                  sub: '${c.selWhName} · ประตู ${c.gate} · เซิร์ฟเวอร์ + บัญชีเครื่อง',
                  onTap: c.goDeviceSetup,
                )
              else
                _tile(
                  icon: Icons.lock_outline,
                  title: 'ตั้งค่าเครื่อง',
                  sub: 'เฉพาะหัวหน้างาน — เครื่องนี้ประจำ ${c.selWhName} ประตู ${c.gate}',
                  onTap: null,
                ),
              if (c.emp != null) ...[
                const SizedBox(height: 10),
                _tile(
                  icon: Icons.swap_horiz,
                  title: 'เปลี่ยนคน / จบงาน',
                  sub: 'กลับไปหน้ายิงบัตร',
                  danger: true,
                  onTap: () => c.lock(),
                ),
              ],
              const SizedBox(height: 18),
              Center(
                child: Text(
                  'BoxTrace PDA · v1.1\nFlutter + Zebra RFIDAPI3 · เชื่อมกับ BoxTrace backend',
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
    final enabled = onTap != null;
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
                child: Icon(icon,
                    size: 21,
                    color: !enabled
                        ? C.faint
                        : danger
                            ? C.red
                            : C.ink2),
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title,
                        style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            color: !enabled
                                ? C.faint
                                : danger
                                    ? C.red
                                    : C.ink)),
                    Text(sub,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12.5, color: C.muted)),
                  ],
                ),
              ),
              if (enabled) Icon(Icons.chevron_right, color: C.chevron, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}
