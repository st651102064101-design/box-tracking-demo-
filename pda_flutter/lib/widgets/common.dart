import 'package:flutter/material.dart';
import '../theme.dart';

/// The "◈" brand mark on the dark rounded tile.
class BrandMark extends StatelessWidget {
  final double size;
  const BrandMark({super.key, this.size = 42});
  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: C.ink,
        borderRadius: BorderRadius.circular(size * 0.29),
      ),
      alignment: Alignment.center,
      child: Text('◈',
          style: TextStyle(color: C.lime, fontSize: size * 0.5, fontWeight: FontWeight.w800)),
    );
  }
}

/// "BoxTrace PDA" wordmark.
class Wordmark extends StatelessWidget {
  final double size;
  const Wordmark({super.key, this.size = 19});
  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        style: TextStyle(fontSize: size, fontWeight: FontWeight.w700, letterSpacing: -0.5, color: C.ink),
        children: const [
          TextSpan(text: 'BoxTrace '),
          TextSpan(text: 'PDA', style: TextStyle(color: C.limeText)),
        ],
      ),
    );
  }
}

/// A white rounded card used across the app.
class Panel extends StatelessWidget {
  final Widget child;
  final EdgeInsets padding;
  final double radius;
  final Color? color;
  final BoxBorder? border;
  final List<BoxShadow>? shadow;
  const Panel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.radius = 16,
    this.color,
    this.border,
    this.shadow,
  });
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? C.surface,
        borderRadius: BorderRadius.circular(radius),
        border: border ?? Border.all(color: C.border),
        boxShadow: shadow,
      ),
      child: child,
    );
  }
}

/// The big lime primary action button (commit / start shift).
class PrimaryButton extends StatelessWidget {
  final String label;
  final VoidCallback? onTap;
  final Widget? trailing;
  final IconData? icon;
  const PrimaryButton({super.key, required this.label, this.onTap, this.trailing, this.icon});
  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return SizedBox(
      width: double.infinity,
      child: Material(
        color: enabled ? C.lime : C.border,
        borderRadius: BorderRadius.circular(16),
        elevation: 0,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(16),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 17),
            decoration: enabled
                ? BoxDecoration(
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: [BoxShadow(color: C.lime.withOpacity(0.4), blurRadius: 22, offset: const Offset(0, 8))],
                  )
                : null,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (icon != null) ...[
                  Icon(icon, size: 20, color: enabled ? C.limeDeep : C.faint),
                  const SizedBox(width: 8),
                ],
                Text(label,
                    style: TextStyle(
                        fontSize: 17, fontWeight: FontWeight.w700, color: enabled ? C.limeDeep : C.faint)),
                if (trailing != null) ...[const SizedBox(width: 10), trailing!],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Round icon button (back chevron, gear, …).
class RoundIconButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final double size;
  const RoundIconButton({super.key, required this.icon, this.onTap, this.size = 36});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.surface,
      shape: CircleBorder(side: const BorderSide(color: C.border)),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(width: size, height: size, child: Icon(icon, size: size * 0.53, color: C.ink)),
      ),
    );
  }
}

/// Small pill/badge.
class Pill extends StatelessWidget {
  final String text;
  final Color color;
  final Color bg;
  final double fontSize;
  const Pill(this.text, {super.key, required this.color, required this.bg, this.fontSize = 11});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: fontSize * 0.8, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(text, style: TextStyle(fontSize: fontSize, fontWeight: FontWeight.w700, color: color)),
    );
  }
}

/// A frosted sticky header with a back button + title/subtitle.
class StickyHeader extends StatelessWidget {
  final VoidCallback? onBack;
  final Widget title;
  final Widget? subtitle;
  final List<Widget> actions;
  const StickyHeader({super.key, this.onBack, required this.title, this.subtitle, this.actions = const []});
  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.of(context).padding.top;
    return Container(
      padding: EdgeInsets.fromLTRB(16, top + 12, 16, 12),
      decoration: const BoxDecoration(
        color: Color(0xDBF5F5F7),
        border: Border(bottom: BorderSide(color: C.border, width: 0.5)),
      ),
      child: Row(
        children: [
          if (onBack != null) ...[
            RoundIconButton(icon: Icons.chevron_left, onTap: onBack),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                DefaultTextStyle(
                  style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: -0.3, color: C.ink),
                  child: title,
                ),
                if (subtitle != null)
                  DefaultTextStyle(
                    style: const TextStyle(fontSize: 12, color: C.muted, fontWeight: FontWeight.w400),
                    child: subtitle!,
                  ),
              ],
            ),
          ),
          ...actions,
        ],
      ),
    );
  }
}

/// Online/offline chip.
class OnlineChip extends StatelessWidget {
  final bool online;
  final VoidCallback? onTap;
  const OnlineChip({super.key, required this.online, this.onTap});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
        decoration: BoxDecoration(
          color: online ? C.surface : C.orangeBg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: online ? C.border2 : C.orangeBorder),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: online ? C.ink2 : C.orange, shape: BoxShape.circle),
            ),
            const SizedBox(width: 6),
            Text(online ? 'ออนไลน์' : 'ออฟไลน์',
                style: TextStyle(
                    fontSize: 11.5, fontWeight: FontWeight.w600, color: online ? C.ink2 : C.orange)),
          ],
        ),
      ),
    );
  }
}

/// Field label above an input.
class FieldLabel extends StatelessWidget {
  final String text;
  const FieldLabel(this.text, {super.key});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(text, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: C.ink3)),
      );
}

/// Shared text-field styling matching the mockup's rounded inputs.
InputDecoration pdaInput(String hint, {double radius = 13}) => InputDecoration(
      hintText: hint,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      filled: true,
      fillColor: C.surface,
      hintStyle: const TextStyle(color: C.faint),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: const BorderSide(color: C.border2, width: 1.5),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: const BorderSide(color: C.border2, width: 1.5),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: const BorderSide(color: C.ink, width: 1.5),
      ),
    );

/// Uppercase muted section caption.
class Caption extends StatelessWidget {
  final String text;
  const Caption(this.text, {super.key});
  @override
  Widget build(BuildContext context) => Text(
        text.toUpperCase(),
        style: const TextStyle(
            fontSize: 12, fontWeight: FontWeight.w700, color: C.muted, letterSpacing: 0.5),
      );
}
