import 'package:flutter/material.dart';
import '../theme.dart';

/// Shared scan guidance for lookup, radar target selection and stock counts.
class ScanPromptCard extends StatelessWidget {
  static const actionBlue = Color(0xFF2563EB);
  final IconData icon;
  final String title;
  final String? subtitle;
  final bool busy;

  const ScanPromptCard({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.busy = false,
  });

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(20, 28, 20, 26),
        decoration: BoxDecoration(
          color: C.surface,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: C.border),
        ),
        child: Column(
          children: [
            Icon(icon, size: 56, color: C.ink2),
            const SizedBox(height: 14),
            Text(title,
                textAlign: TextAlign.center,
                style:
                    const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            if (subtitle != null) ...[
              const SizedBox(height: 4),
              Text(subtitle!,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13.5, color: C.muted)),
            ],
            if (busy) ...[
              const SizedBox(height: 12),
              const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2)),
            ],
          ],
        ),
      );
}
