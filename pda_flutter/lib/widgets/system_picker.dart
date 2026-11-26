import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../services/i18n.dart';
import '../theme.dart';

/// The two systems of this app, picked like a game mode: one tap, no menu.
class SystemPicker extends StatelessWidget {
  const SystemPicker({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    return Row(
      children: [
        Expanded(
          child: _Card(
            icon: Icons.swap_vert_rounded,
            title: loc.t('รับ-ส่ง'),
            sub: loc.t('รับเข้า และ จ่ายออก'),
            selected: c.receiveShipOnly,
            onTap: () => c.setReceiveShipOnly(true),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _Card(
            icon: Icons.apps_outlined,
            title: loc.t('ครบทุกฟีเจอร์'),
            sub: loc.t('ทุกเมนู'),
            selected: !c.receiveShipOnly,
            onTap: () => c.setReceiveShipOnly(false),
          ),
        ),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  final IconData icon;
  final String title;
  final String sub;
  final bool selected;
  final VoidCallback onTap;
  const _Card({
    required this.icon,
    required this.title,
    required this.sub,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 112),
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: selected ? C.menuGreenBg : null,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(
                color: selected ? C.menuGreen : C.chevron,
                width: selected ? 2.5 : 1),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Icon(icon, size: 28),
                  if (selected)
                    Icon(Icons.check_circle, size: 20, color: C.menuGreen),
                ],
              ),
              const SizedBox(height: 10),
              Text(title,
                  style: const TextStyle(
                      fontSize: 16, fontWeight: FontWeight.w800)),
              Text(sub, style: TextStyle(fontSize: 12, color: C.muted)),
            ],
          ),
        ),
      ),
    );
  }
}
