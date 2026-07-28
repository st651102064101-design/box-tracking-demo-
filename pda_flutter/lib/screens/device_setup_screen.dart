import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/i18n.dart';
import '../services/theme_controller.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Provisioning a terminal — done once, by whoever hands the device out.
///
/// This screen is the reason operators never see a setup step: the warehouse
/// and gate are properties of *this device at this door*, so they are answered
/// here and then never asked again. It also holds the one password in the
/// whole product — the device's own service account, typed by an admin, never
/// by warehouse staff.
class DeviceSetupScreen extends StatefulWidget {
  const DeviceSetupScreen({super.key});

  @override
  State<DeviceSetupScreen> createState() => _DeviceSetupScreenState();
}

class _DeviceSetupScreenState extends State<DeviceSetupScreen> {
  late final TextEditingController _url;
  late final TextEditingController _account;
  late final TextEditingController _password;
  bool _showAccount = false;

  @override
  void initState() {
    super.initState();
    final c = context.read<AppController>();
    _url = TextEditingController(text: c.prefs.baseUrl);
    _account = TextEditingController(text: c.prefs.username);
    _password = TextEditingController();
  }

  @override
  void dispose() {
    _url.dispose();
    _account.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final themeCtrl = context.watch<ThemeController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final canSave = c.wh.isNotEmpty && c.gate.isNotEmpty;
    // A device being provisioned for the first time has nowhere to go back to.
    final canLeave = c.deviceConfigured;

    return Column(
      children: [
        StickyHeader(
          onBack: canLeave ? c.backToHome : null,
          title: Text(loc.t('ตั้งค่าเครื่อง')),
          subtitle: Text(loc.t('ตั้งครั้งเดียว — พนักงานไม่ต้องเลือกอีก')),
          actions: [LangToggleButton(loc: loc), const SizedBox(width: 8), ThemeToggleButton(ctrl: themeCtrl)],
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 18, 16, bottom + 96),
            children: [
              _StepLabel(loc.t('1 · การเชื่อมต่อระบบหลัก')),
              const SizedBox(height: 11),
              Panel(
                padding: const EdgeInsets.all(16),
                radius: 18,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 11,
                          height: 11,
                          decoration: BoxDecoration(
                            color: c.connected ? C.lime : C.red,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 11),
                        Expanded(
                          child: Text(
                            c.connected
                                ? '${loc.t('เชื่อมต่อแล้ว')} · ${c.boxCount} ${loc.t('กล่อง')}'
                                : (c.connError ?? loc.t('ยังไม่พบข้อมูล')),
                            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    FieldLabel(loc.t('ที่อยู่เซิร์ฟเวอร์')),
                    TextField(
                      controller: _url,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      decoration: pdaInput('http://192.168.1.10:4000'),
                    ),
                    const SizedBox(height: 10),
                    // Collapsed by default: on a device that already works,
                    // nobody should be poking at its credentials.
                    GestureDetector(
                      onTap: () => setState(() => _showAccount = !_showAccount),
                      child: Row(
                        children: [
                          Icon(_showAccount ? Icons.expand_less : Icons.expand_more,
                              size: 18, color: C.muted),
                          const SizedBox(width: 4),
                          Text(loc.t('บัญชีประจำเครื่อง'),
                              style: TextStyle(fontSize: 12.5, color: C.muted, fontWeight: FontWeight.w600)),
                        ],
                      ),
                    ),
                    if (_showAccount) ...[
                      const SizedBox(height: 10),
                      TextField(
                        controller: _account,
                        autocorrect: false,
                        decoration: pdaInput(loc.t('ชื่อบัญชีเครื่อง เช่น pda-01')),
                      ),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _password,
                        obscureText: true,
                        decoration: pdaInput(loc.t('รหัสผ่าน (เว้นว่าง = ไม่เปลี่ยน)')),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        loc.t('บัญชีนี้เป็นของเครื่อง ไม่ใช่ของพนักงาน — ตั้งครั้งเดียวตอนแจกเครื่อง'),
                        style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.4),
                      ),
                    ],
                    const SizedBox(height: 14),
                    PrimaryButton(
                      label: c.busy ? loc.t('กำลังเชื่อมต่อ…') : loc.t('บันทึก & เชื่อมต่อ'),
                      onTap: c.busy
                          ? null
                          : () => c.applyConnection(
                                baseUrl: _url.text,
                                username: _account.text,
                                password: _password.text,
                              ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 18),
              _StepLabel(loc.t('2 · เครื่องนี้ประจำคลังไหน')),
              const SizedBox(height: 11),
              if (c.warehouseList.isEmpty)
                Text(loc.t('เชื่อมต่อระบบหลักก่อน จึงจะเลือกคลังได้'),
                    style: TextStyle(fontSize: 13, color: C.faint)),
              ...c.warehouseList.map((w) {
                final id = (w['id'] ?? '').toString();
                final gs = (w['gates'] is List) ? (w['gates'] as List) : const [];
                final gText = gs.isEmpty
                    ? loc.gateRangeText(null, null)
                    : loc.gateRangeText(int.tryParse('${gs.first}'), int.tryParse('${gs.last}'));
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _WarehouseTile(
                    name: (w['name'] ?? id).toString(),
                    gateText: gText,
                    selected: c.wh == id,
                    onTap: () => c.pickWh(id),
                  ),
                );
              }),
              if (c.wh.isNotEmpty) ...[
                const SizedBox(height: 12),
                _StepLabel('${loc.t('3 · ประจำประตูไหน')} — ${c.selWhName}'),
                const SizedBox(height: 11),
                Wrap(
                  spacing: 9,
                  runSpacing: 9,
                  children: c.currentGates.map((g) {
                    return _GateChip(
                      label: '$g',
                      dirLabel: _dirLabel(c.gateTypeOf(g), loc),
                      selected: c.gate == '$g',
                      onTap: () => c.pickGate(g),
                    );
                  }).toList(),
                ),
              ],
              const SizedBox(height: 20),
              // Unnumbered: the numbered steps are the "where does this device
              // live" flow, and step 3 only appears once a warehouse is picked —
              // numbering this one too would show a 1 · 2 · 4 gap until then.
              _StepLabel(loc.t('ล็อกหน้าจอเมื่อไม่มีการใช้งาน')),
              const SizedBox(height: 11),
              _IdleLockPicker(
                minutes: c.prefs.idleLockMinutes,
                onPick: c.setIdleLockMinutes,
                loc: loc,
              ),
            ],
          ),
        ),
        Container(
          padding: EdgeInsets.fromLTRB(16, 12, 16, bottom + 14),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.bottomCenter,
              end: Alignment.topCenter,
              colors: [C.bg, const Color(0x00F5F5F7)],
              stops: const [0.68, 1],
            ),
          ),
          child: PrimaryButton(
            label: loc.t('บันทึกและเริ่มใช้งาน'),
            trailing: Icon(Icons.arrow_forward, size: 19, color: canSave ? C.limeDeep : C.faint),
            onTap: canSave ? c.saveDevicePost : null,
          ),
        ),
      ],
    );
  }

  static String _dirLabel(String dir, LocaleController loc) {
    switch (dir) {
      case 'in':
        return loc.t('เข้า');
      case 'out':
        return loc.t('ออก');
      default:
        return loc.t('เข้า/ออก');
    }
  }
}

/// Idle timeout choices, in minutes. 0 disables auto-lock outright, which is
/// a legitimate answer for a device that never leaves one person's hands.
class _IdleLockPicker extends StatelessWidget {
  final int minutes;
  final ValueChanged<int> onPick;
  final LocaleController loc;
  const _IdleLockPicker({required this.minutes, required this.onPick, required this.loc});

  static const _options = [0, 5, 10, 30];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 9,
          runSpacing: 9,
          children: _options
              .map((m) => _GateChip(
                    label: m == 0 ? loc.t('ไม่ล็อก') : '$m',
                    dirLabel: m == 0 ? null : loc.t('นาที'),
                    selected: minutes == m,
                    onTap: () => onPick(m),
                  ))
              .toList(),
        ),
        const SizedBox(height: 8),
        Text(
          loc.t('ยิงบัตรอีกครั้งเพื่อปลดล็อก · จะไม่ล็อกขณะมีกล่องค้างอยู่ในคิว'),
          style: TextStyle(fontSize: 11.5, color: C.faint, height: 1.4),
        ),
      ],
    );
  }
}

class _StepLabel extends StatelessWidget {
  final String text;
  const _StepLabel(this.text);
  @override
  Widget build(BuildContext context) =>
      Text(text, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: C.ink));
}

class _WarehouseTile extends StatelessWidget {
  final String name, gateText;
  final bool selected;
  final VoidCallback onTap;
  const _WarehouseTile({required this.name, required this.gateText, required this.selected, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: selected ? C.ink : C.border, width: selected ? 1.5 : 1),
            boxShadow: selected
                ? [BoxShadow(color: Colors.black.withValues(alpha: 0.1), blurRadius: 14, offset: const Offset(0, 4))]
                : null,
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(name, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
                    Text(gateText, style: TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              if (selected)
                Container(
                  width: 24,
                  height: 24,
                  decoration: BoxDecoration(color: C.lime, shape: BoxShape.circle),
                  child: Icon(Icons.check, size: 15, color: C.limeDeep),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _GateChip extends StatelessWidget {
  final String label;
  final String? dirLabel;
  final bool selected;
  final VoidCallback onTap;
  const _GateChip({required this.label, this.dirLabel, required this.selected, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? C.ink : C.surface,
      borderRadius: BorderRadius.circular(13),
      child: InkWell(
        borderRadius: BorderRadius.circular(13),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minWidth: 64),
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: selected ? C.ink : C.border2, width: selected ? 1.5 : 1),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label,
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                      color: selected ? Colors.white : C.ink,
                      fontFeatures: const [FontFeature.tabularFigures()])),
              if (dirLabel != null)
                Text(dirLabel!,
                    style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.3,
                        color: selected ? Colors.white70 : C.muted)),
            ],
          ),
        ),
      ),
    );
  }
}
