import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/i18n.dart';
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
        color: C.heroBg,
        borderRadius: BorderRadius.circular(size * 0.29),
      ),
      alignment: Alignment.center,
      child: Text('◈',
          style: TextStyle(
              color: C.lime,
              fontSize: size * 0.5,
              fontWeight: FontWeight.w800)),
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
        style: TextStyle(
            fontSize: size,
            fontWeight: FontWeight.w700,
            letterSpacing: -0.5,
            color: C.ink),
        children: [
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
  const PrimaryButton(
      {super.key, required this.label, this.onTap, this.trailing, this.icon});
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
                    boxShadow: [
                      BoxShadow(
                          color: C.lime.withOpacity(0.4),
                          blurRadius: 22,
                          offset: const Offset(0, 8))
                    ],
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
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                        color: enabled ? C.limeDeep : C.faint)),
                if (trailing != null) ...[const SizedBox(width: 10), trailing!],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// iOS-style back affordance: a bare, thin "‹" chevron with no button
/// chrome around it, sized to a comfortable 44×44 tap target the way Apple
/// specifies. Deliberately not a [RoundIconButton] — a bordered circle reads
/// as "an action", while back is navigation and should recede.
class BackChevron extends StatelessWidget {
  final VoidCallback? onTap;
  const BackChevron({super.key, this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
          width: 44,
          height: 44,
          // arrow_back_ios_new is Apple's own chevron shape (the older
          // arrow_back_ios carries a stray leading gap).
          child: Icon(Icons.arrow_back_ios_new, size: 20, color: C.ink),
        ),
      ),
    );
  }
}

/// Round icon button (gear, …).
class RoundIconButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onTap;
  final double size;
  const RoundIconButton(
      {super.key, required this.icon, this.onTap, this.size = 36});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.surface,
      shape: CircleBorder(side: BorderSide(color: C.border)),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
            width: size,
            height: size,
            child: Icon(icon, size: size * 0.53, color: C.ink)),
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
  const Pill(this.text,
      {super.key, required this.color, required this.bg, this.fontSize = 11});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: fontSize * 0.8, vertical: 4),
      decoration:
          BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(text,
          style: TextStyle(
              fontSize: fontSize, fontWeight: FontWeight.w700, color: color)),
    );
  }
}

/// A frosted sticky header with a back button + title/subtitle.
class StickyHeader extends StatelessWidget {
  final VoidCallback? onBack;
  final Widget title;
  final Widget? subtitle;
  final List<Widget> actions;
  const StickyHeader(
      {super.key,
      this.onBack,
      required this.title,
      this.subtitle,
      this.actions = const []});
  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.of(context).padding.top;
    return Container(
      padding: EdgeInsets.fromLTRB(8, top + 12, 16, 12),
      decoration: BoxDecoration(
        // Was a hardcoded near-white (0xDBF5F5F7), which left every
        // sub-screen wearing a light header bar in dark mode. C.bg tracks
        // the theme, so it follows the rest of the app.
        color: C.bg,
        border: Border(bottom: BorderSide(color: C.border, width: 0.5)),
      ),
      child: Row(
        children: [
          if (onBack != null)
            BackChevron(onTap: onBack)
          else
            const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                DefaultTextStyle(
                  style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.3,
                      color: C.ink),
                  child: title,
                ),
                if (subtitle != null)
                  DefaultTextStyle(
                    style: TextStyle(
                        fontSize: 12,
                        color: C.muted,
                        fontWeight: FontWeight.w400),
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

/// Wraps a screen's [header] (almost always a [StickyHeader]) and its
/// scrollable [body] so the header smoothly slides/fades away on scroll-down
/// and back on scroll-up — the same iOS Safari/Twitter-style compact nav bar
/// behavior, on every screen that has one, rather than each screen wiring
/// its own ScrollController and animation.
///
/// [body] carries everything that used to sit below the header in that
/// screen's own `Column` — typically an `Expanded(child: ListView(...))`
/// plus whatever fixed bottom bar/button follows it — since this widget's
/// [NotificationListener] only needs to see scroll events bubble up through
/// it, not own the scroll view itself. A screen adopts this by wrapping its
/// existing `Column(children: [StickyHeader(...), ...rest])` as
/// `AutoHideHeader(header: StickyHeader(...), body: Column(children: [...rest]))`.
///
/// Direction is read straight off each [ScrollUpdateNotification]'s own
/// delta rather than tracked via a owned ScrollController, so this works
/// unmodified with any descendant scrollable (ListView, SingleChildScrollView,
/// nested ones) without the wrapped screen having to expose its controller.
class AutoHideHeader extends StatefulWidget {
  final Widget header;
  final Widget body;
  const AutoHideHeader({super.key, required this.header, required this.body});

  @override
  State<AutoHideHeader> createState() => _AutoHideHeaderState();
}

class _AutoHideHeaderState extends State<AutoHideHeader> {
  bool _visible = true;

  bool _onScroll(ScrollNotification n) {
    // Per-frame scrollDelta during a drag is small (a few px), so a high
    // threshold here effectively meant "flick fast, or scroll all the way
    // back to the top" before the header would reappear. 2px still filters
    // overscroll-bounce noise but reacts to an ordinary, unhurried drag.
    if (n is ScrollUpdateNotification) {
      final delta = n.scrollDelta ?? 0;
      if (delta.abs() < 2) return false;
      // Always show once back near the top — the header reappearing only
      // on an upward flick, never on arriving at the top some other way
      // (e.g. a jump-to-top tap), was the one case that felt broken to hide.
      final show = delta < 0 || n.metrics.pixels <= 0;
      if (show != _visible) setState(() => _visible = show);
    } else if (n is ScrollEndNotification &&
        n.metrics.pixels <= 0 &&
        !_visible) {
      setState(() => _visible = true);
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        ClipRect(
          child: AnimatedSize(
            duration: const Duration(milliseconds: 260),
            curve: Curves.easeOutCubic,
            child: AnimatedOpacity(
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOut,
              opacity: _visible ? 1 : 0,
              child: _visible
                  ? widget.header
                  : const SizedBox(width: double.infinity, height: 0),
            ),
          ),
        ),
        Expanded(
          child: NotificationListener<ScrollNotification>(
            onNotification: _onScroll,
            child: widget.body,
          ),
        ),
      ],
    );
  }
}

/// Online/offline indicator — icon only, no label. Green means "connected,"
/// gray means "not" — orange is reserved for warnings elsewhere in the app,
/// so offline deliberately isn't that color even though it's a
/// less-than-ideal state. Used in the Home/Gate headers where "ออนไลน์" /
/// "ออฟไลน์" spelled out just crowded a row that already has the operator's
/// name, warehouse, and gate competing for the same space.
class OnlineChip extends StatelessWidget {
  final bool online;
  final VoidCallback? onTap;
  const OnlineChip({super.key, required this.online, this.onTap});
  @override
  Widget build(BuildContext context) {
    final loc = context.watch<LocaleController>();
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: online ? C.limeBg : C.neutralBg,
          borderRadius: BorderRadius.circular(17),
          border: Border.all(color: online ? C.limeBorder : C.border2),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(online ? Icons.cloud_done_outlined : Icons.cloud_off_outlined,
                size: 16, color: online ? C.limeText : C.muted),
            const SizedBox(width: 5),
            Text(loc.t(online ? 'ออนไลน์' : 'ออฟไลน์'),
                style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w700,
                    color: online ? C.limeText : C.muted)),
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
        child: Text(text,
            style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w600, color: C.ink3)),
      );
}

/// Shared text-field styling matching the mockup's rounded inputs.
InputDecoration pdaInput(String hint, {double radius = 13}) => InputDecoration(
      hintText: hint,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      filled: true,
      fillColor: C.surface,
      hintStyle: TextStyle(color: C.faint),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: C.border2, width: 1.5),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: C.border2, width: 1.5),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: C.ink, width: 1.5),
      ),
    );

/// Uppercase muted section caption.
class Caption extends StatelessWidget {
  final String text;
  const Caption(this.text, {super.key});
  @override
  Widget build(BuildContext context) => Text(
        text.toUpperCase(),
        style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: C.muted,
            letterSpacing: 0.5),
      );
}

/// A dropdown for one location field (zone/rack/shelf/slot) that also lets
/// the operator type a brand-new value inline via an "+ เพิ่มใหม่" entry —
/// selecting it opens a small text prompt, and the typed value becomes both
/// the new dropdown option and the current selection. An empty selection
/// ("— ไม่ระบุ —") is always available since every one of these fields is
/// optional on the backend.
class LocationDropdown extends StatelessWidget {
  final String label;
  final List<String> options;
  final String value;
  final ValueChanged<String> onChanged;
  final LocaleController loc;
  final bool dense;
  const LocationDropdown({
    super.key,
    required this.label,
    required this.options,
    required this.value,
    required this.onChanged,
    required this.loc,
    this.dense = false,
  });

  static const _addNew = ' __add_new__';
  static const _empty = '';

  Future<void> _promptNew(BuildContext context) async {
    final ctrl = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('${loc.t('เพิ่ม')} $label'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          decoration: InputDecoration(hintText: label),
          onSubmitted: (v) => Navigator.of(ctx).pop(v.trim()),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text(loc.t('ยกเลิก'))),
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
              child: Text(loc.t('เพิ่ม'))),
        ],
      ),
    );
    if (result != null && result.isNotEmpty) onChanged(result);
  }

  @override
  Widget build(BuildContext context) {
    final items = <String>{...options, if (value.isNotEmpty) value}.toList()
      ..sort();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        FieldLabel(label),
        DropdownButtonFormField<String>(
          initialValue: value.isEmpty ? _empty : value,
          isExpanded: true,
          isDense: dense,
          decoration: pdaInput('— ${loc.t('ไม่ระบุ')} —', radius: 12),
          items: [
            DropdownMenuItem(
                value: _empty,
                child: Text('— ${loc.t('ไม่ระบุ')} —',
                    style: TextStyle(color: C.faint))),
            ...items.map((v) => DropdownMenuItem(
                value: v, child: Text(v, overflow: TextOverflow.ellipsis))),
            DropdownMenuItem(
              value: _addNew,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.add, size: 16, color: C.limeText),
                  const SizedBox(width: 4),
                  Text(loc.t('เพิ่มใหม่'),
                      style: TextStyle(
                          color: C.limeText, fontWeight: FontWeight.w700)),
                ],
              ),
            ),
          ],
          onChanged: (v) {
            if (v == null) return;
            if (v == _addNew) {
              _promptNew(context);
              return;
            }
            onChanged(v);
          },
        ),
      ],
    );
  }
}
