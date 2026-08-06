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
        color: C.heroBg,
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
  const RoundIconButton({super.key, required this.icon, this.onTap, this.size = 36});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.surface,
      shape: CircleBorder(side: BorderSide(color: C.border)),
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
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: -0.3, color: C.ink),
                  child: title,
                ),
                if (subtitle != null)
                  DefaultTextStyle(
                    style: TextStyle(fontSize: 12, color: C.muted, fontWeight: FontWeight.w400),
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

/// Online/offline indicator — one real, auto-detected state (see
/// AppController.connected, kept live by RealtimeService's SSE heartbeat)
/// used identically everywhere it appears (badge screen, Home, Gate) so the
/// app never shows two different answers to "am I online?" at once. Green
/// means "connected," gray means "not" — orange is reserved for warnings
/// elsewhere in the app, so offline deliberately isn't that color even
/// though it's a less-than-ideal state.
///
/// Labeled (not icon-only) since a bare cloud glyph reads as decoration —
/// spelling out "Online"/"Offline" is what makes it legible as a status at
/// a glance. There is deliberately no way to force this to say "online"
/// (tapping while offline can only retry the real connection, never fake
/// it) and no way to force it to "offline" either — that used to be a
/// separate manual toggle, which is exactly what let this chip disagree
/// with the actual connection state.
class OnlineChip extends StatelessWidget {
  final bool online;
  final VoidCallback? onTap;
  const OnlineChip({super.key, required this.online, this.onTap});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 34,
        padding: const EdgeInsets.symmetric(horizontal: 11),
        decoration: BoxDecoration(
          color: online ? C.limeBg : C.neutralBg,
          borderRadius: BorderRadius.circular(17),
          border: Border.all(color: online ? C.limeBorder : C.border2),
        ),
        alignment: Alignment.center,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(online ? Icons.cloud_done_outlined : Icons.cloud_off_outlined,
                size: 16, color: online ? C.limeText : C.muted),
            const SizedBox(width: 6),
            Text(online ? 'Online' : 'Offline',
                style: TextStyle(
                    fontSize: 12, fontWeight: FontWeight.w700, color: online ? C.limeText : C.muted)),
          ],
        ),
      ),
    );
  }
}

/// Field label above an input. [error], when set, appends the validation
/// message inline in red right after the label — one place a form field's
/// "what's wrong with this" lives, instead of every screen inventing its own
/// red-text-somewhere-nearby convention.
class FieldLabel extends StatelessWidget {
  final String text;
  final String? error;
  const FieldLabel(this.text, {super.key, this.error});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text.rich(
          TextSpan(
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: C.ink3),
            children: [
              TextSpan(text: text),
              if (error != null) TextSpan(text: '  ·  $error', style: TextStyle(color: C.red)),
            ],
          ),
        ),
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

/// A dropdown that can add its own new option, instead of every screen
/// needing a separate "manage X" admin flow before a genuinely new zone,
/// box type, or customer can be picked at all. The "+ เพิ่มใหม่" action is
/// pinned as the very first row so it's visible without scrolling the list
/// no matter how many real options exist — see the ask this was built for:
/// every dropdown in the app should let the operator add a missing value
/// right there, not send them somewhere else first.
///
/// [onAdd] is given whatever text the operator typed in the prompt and
/// returns the value to select once added (typically after an API call
/// that persists it) — return null to cancel without changing the
/// selection. [value]/[options]/[onChanged] behave like a normal dropdown.
class AddableDropdown extends StatelessWidget {
  final String? value;
  final List<String> options;
  final String Function(String value) labelFor;
  final ValueChanged<String?> onChanged;
  final Future<String?> Function(String typed) onAdd;
  final String hint;
  final String addLabel;
  final double radius;
  // Where the cursor should land once a real option is picked and the
  // dropdown closes — the operator is filling in a form top-to-bottom and
  // shouldn't have to tap the next field by hand every time. Not requested
  // for the "+ เพิ่มใหม่" path, which opens its own dialog instead.
  final FocusNode? nextFocus;
  /// Validation message — red border + red text below, same as any other
  /// PDA form field. Null (the default) renders exactly as before.
  final String? errorText;

  const AddableDropdown({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    required this.onAdd,
    this.labelFor = _identity,
    this.hint = '— ไม่ระบุ —',
    this.addLabel = '+ เพิ่มใหม่…',
    this.radius = 12,
    this.nextFocus,
    this.errorText,
  });

  static String _identity(String v) => v;

  static const _addSentinel = ' __add_new__';

  Future<void> _promptAdd(BuildContext context) async {
    final ctrl = TextEditingController();
    final typed = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('เพิ่มรายการใหม่'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          decoration: pdaInput('พิมพ์ค่าใหม่'),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('ยกเลิก')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('เพิ่ม'),
          ),
        ],
      ),
    );
    if (typed == null || typed.isEmpty || !context.mounted) return;
    final added = await onAdd(typed);
    if (added != null) onChanged(added);
  }

  @override
  Widget build(BuildContext context) {
    return DropdownButtonFormField<String>(
      initialValue: (value != null && options.contains(value)) ? value : null,
      isExpanded: true,
      decoration: pdaInput(hint, radius: radius).copyWith(errorText: errorText, errorMaxLines: 2),
      items: [
        DropdownMenuItem(
          value: _addSentinel,
          child: Text(addLabel, style: TextStyle(color: C.limeText, fontWeight: FontWeight.w700)),
        ),
        ...options.map((v) => DropdownMenuItem(value: v, child: Text(labelFor(v), overflow: TextOverflow.ellipsis))),
      ],
      onChanged: (v) {
        if (v == _addSentinel) {
          _promptAdd(context);
        } else {
          onChanged(v);
          // The framework closes the dropdown's own menu before this
          // callback fires, but focus needs to move after that teardown
          // settles — otherwise the request loses to the dropdown reclaiming
          // focus on its way out.
          if (nextFocus != null) {
            WidgetsBinding.instance.addPostFrameCallback((_) => nextFocus!.requestFocus());
          }
        }
      },
    );
  }
}

/// Uppercase muted section caption.
class Caption extends StatelessWidget {
  final String text;
  const Caption(this.text, {super.key});
  @override
  Widget build(BuildContext context) => Text(
        text.toUpperCase(),
        style: TextStyle(
            fontSize: 12, fontWeight: FontWeight.w700, color: C.muted, letterSpacing: 0.5),
      );
}
