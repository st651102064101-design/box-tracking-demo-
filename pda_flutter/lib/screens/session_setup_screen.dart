import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';

class SessionSetupScreen extends StatelessWidget {
  const SessionSetupScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final canStart = c.wh.isNotEmpty && c.gate.isNotEmpty;

    return Column(
      children: [
        StickyHeader(
          onBack: () => c.go(Screen.login),
          title: Text(loc.t('ตั้งค่ากะทำงาน')),
          subtitle: Text('${loc.t('ผู้ปฏิบัติงาน')} · ${c.user}'),
          actions: [LangToggleButton(loc: loc)],
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, 18, 16, bottom + 96),
            children: [
              _StepLabel(loc.t('1 · เลือกคลังสินค้า')),
              const SizedBox(height: 11),
              ...c.warehouseList.map((w) {
                final id = (w['id'] ?? '').toString();
                final gs = (w['gates'] is List) ? (w['gates'] as List) : const [];
                final gText = gs.isEmpty
                    ? loc.gateRangeText(null, null)
                    : loc.gateRangeText(int.tryParse('${gs.first}'), int.tryParse('${gs.last}'));
                final sel = c.wh == id;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _WarehouseTile(
                    name: (w['name'] ?? id).toString(),
                    gateText: gText,
                    selected: sel,
                    onTap: () => c.pickWh(id),
                  ),
                );
              }),
              if (c.wh.isNotEmpty) ...[
                const SizedBox(height: 12),
                _StepLabel(loc.gateStepLabel(c.selWhName)),
                const SizedBox(height: 11),
                Wrap(
                  spacing: 9,
                  runSpacing: 9,
                  children: c.currentGates.map((g) {
                    final sel = c.gate == '$g';
                    final dir = c.gateTypeOf(g);
                    return _GateChip(
                      label: '$g',
                      dirLabel: _dirLabel(dir, loc),
                      selected: sel,
                      onTap: () => c.pickGate(g),
                    );
                  }).toList(),
                ),
              ],
            ],
          ),
        ),
        Container(
          padding: EdgeInsets.fromLTRB(16, 12, 16, bottom + 14),
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.bottomCenter,
              end: Alignment.topCenter,
              colors: [C.bg, Color(0x00F5F5F7)],
              stops: [0.68, 1],
            ),
          ),
          child: PrimaryButton(
            label: loc.t('เริ่มกะทำงาน'),
            icon: null,
            trailing: canStart
                ? const Icon(Icons.arrow_forward, size: 19, color: C.limeDeep)
                : const Icon(Icons.arrow_forward, size: 19, color: C.faint),
            onTap: canStart ? c.startShift : null,
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

class _StepLabel extends StatelessWidget {
  final String text;
  const _StepLabel(this.text);
  @override
  Widget build(BuildContext context) =>
      Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: C.ink));
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
                ? [BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 14, offset: const Offset(0, 4))]
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
                    Text(gateText, style: const TextStyle(fontSize: 12, color: C.muted)),
                  ],
                ),
              ),
              if (selected)
                Container(
                  width: 24,
                  height: 24,
                  decoration: const BoxDecoration(color: C.lime, shape: BoxShape.circle),
                  child: const Icon(Icons.check, size: 15, color: C.limeDeep),
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
