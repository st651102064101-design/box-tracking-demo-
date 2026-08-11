import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../controllers/app_controller.dart';
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

/// "SmartTrace PDA" wordmark.
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
          TextSpan(text: 'SmartTrace '),
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

/// The only way to put a location onto a box anywhere in this app: scan the
/// barcode physically stuck to that shelf.
///
/// There is deliberately no dropdown, no list, and no free-text fallback. A
/// picker can be operated from anywhere in the building — the whole warehouse
/// fits in it, and the wrong entry is always one row away from the right one.
/// A shelf barcode can only be read while standing at that shelf, which makes
/// the scan the one piece of evidence that the box and the location about to
/// be recorded are actually in the same place. Every screen that writes a
/// location (Gate In putaway, ย้ายตำแหน่ง, box registration) goes through here
/// so that guarantee holds everywhere rather than screen by screen.
///
/// [expected] turns this into a *directed* confirmation: any other valid
/// shelf is rejected as the wrong one, not quietly accepted.
class LocationScanField extends StatefulWidget {
  final AppController controller;
  final LocaleController loc;

  /// When set, only this exact zone/rack/shelf/slot is accepted.
  final Map<String, String>? expected;

  /// Called with the resolved location once a scan is accepted.
  final ValueChanged<Map<String, String>> onConfirmed;

  final String? hintText;
  final bool autofocus;

  const LocationScanField({
    super.key,
    required this.controller,
    required this.loc,
    required this.onConfirmed,
    this.expected,
    this.hintText,
    this.autofocus = true,
  });

  @override
  State<LocationScanField> createState() => _LocationScanFieldState();
}

class _LocationScanFieldState extends State<LocationScanField> {
  final _ctrl = TextEditingController();
  final _focus = FocusNode();
  Timer? _timer;
  int _prevLen = 0;
  String? _error;

  /// This terminal's barcode engine is a keyboard wedge that doesn't reliably
  /// send a trailing Enter, so onSubmitted alone would strand a good scan in
  /// the field. Same two-part fallback used everywhere else in the app: a
  /// burst of characters in one callback is scanner speed no typist reaches
  /// and resolves at once; anything slower waits for the field to go quiet.
  void _onChanged(String v) {
    _timer?.cancel();
    final text = v.trim();
    final added = v.length - _prevLen;
    _prevLen = v.length;
    if (text.length < 2) return;
    if (added > 1) {
      _resolve(text);
      return;
    }
    _timer = Timer(const Duration(milliseconds: 180), () {
      if (!mounted || _ctrl.text.trim() != text) return;
      _resolve(text);
    });
  }

  void _resolve(String raw) {
    final c = widget.controller;
    final loc = widget.loc;
    final code = raw.trim();
    if (code.isEmpty) return;
    final found = c.S?.locationByCode(c.wh, code);
    if (found == null) {
      _reject('${loc.t('ไม่พบตำแหน่งรหัส')} "$code"');
      return;
    }
    final want = widget.expected;
    if (want != null && !_sameLocation(found, want)) {
      _reject(
          '${loc.t('ผิดช่อง — ระบบกำหนดให้เก็บที่')} ${locationText(want)}');
      return;
    }
    c.rfid.playSound('putaway_ok');
    HapticFeedback.mediumImpact();
    _ctrl.clear();
    _prevLen = 0;
    setState(() => _error = null);
    widget.onConfirmed(found);
  }

  void _reject(String message) {
    widget.controller.rfid.playSound('putaway_err');
    HapticFeedback.heavyImpact();
    _ctrl.clear();
    _prevLen = 0;
    setState(() => _error = message);
    _focus.requestFocus();
  }

  static bool _sameLocation(Map<String, String> a, Map<String, String> b) => [
        'zone',
        'rack',
        'shelf',
        'slot'
      ].every((k) => (a[k] ?? '') == (b[k] ?? ''));

  @override
  void dispose() {
    _timer?.cancel();
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final loc = widget.loc;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: _ctrl,
          focusNode: _focus,
          autofocus: widget.autofocus,
          textCapitalization: TextCapitalization.characters,
          autocorrect: false,
          enableSuggestions: false,
          onChanged: _onChanged,
          onSubmitted: _resolve,
          style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              fontFamily: 'monospace'),
          decoration: pdaInput(widget.hintText ?? loc.t('ยิงบาร์โค้ดชั้นวาง'),
                  radius: 14)
              .copyWith(prefixIcon: Icon(Icons.qr_code_scanner)),
        ),
        if (_error != null) ...[
          const SizedBox(height: 10),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
            decoration: BoxDecoration(
              color: C.redBg,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(_error!,
                style: TextStyle(
                    fontSize: 13,
                    color: C.red,
                    fontWeight: FontWeight.w700,
                    height: 1.4)),
          ),
        ],
      ],
    );
  }
}

/// "A / 1 / 2" from a zone/rack/shelf/slot map, skipping the empty levels.
String locationText(Map<String, String> l) => [
      l['zone'],
      l['rack'],
      l['shelf'],
      l['slot'],
    ].where((v) => (v ?? '').isNotEmpty).join(' / ');

/// The บาร์โค้ด / RFID switch, shared by every screen that offers both.
///
/// The two are genuinely different jobs, not two spellings of "scan": the
/// imager reads one code from a narrow beam at arm's length, the antenna
/// sweeps every tag within metres of wherever it happens to be pointed. Which
/// one is armed decides what a trigger pull means and what a decoded barcode
/// is allowed to do, so the operator has to be able to see and set it — an
/// app that guesses will eventually guess wrong in a rack full of tags.
///
/// The selection itself lives on [AppController.scanInputMode] rather than in
/// each screen, because the hardware trigger is dispatched centrally too (see
/// AppController._onReaderTrigger) — a screen-local toggle that dispatcher
/// never saw is exactly how "barcode mode" still fired the antenna.
class ScanModeToggle extends StatelessWidget {
  /// Extra label on the RFID segment, e.g. "หลายกล่อง" where a sweep is a
  /// bulk-select rather than a single read.
  final String? rfidNote;

  /// Per-screen side effects of the switch — clearing a sweep list, pushing
  /// the reader to full power. The mode change itself is already done.
  final ValueChanged<ScanInputMode>? onChanged;

  const ScanModeToggle({super.key, this.rfidNote, this.onChanged});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();

    Widget seg(ScanInputMode m, String label, IconData icon) {
      final selected = c.scanInputMode == m;
      return Expanded(
        child: GestureDetector(
          // Opaque so a tap anywhere on the segment counts, not just on the
          // glyphs — this is worn with gloves on.
          behavior: HitTestBehavior.opaque,
          onTap: () {
            if (c.scanInputMode == m) return;
            c.setScanInputMode(m);
            onChanged?.call(m);
          },
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              color: selected ? C.ink : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 15, color: selected ? C.surface : C.ink2),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          color: selected ? C.surface : C.ink2)),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
          color: C.neutralBg2, borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          seg(ScanInputMode.barcode, loc.t('บาร์โค้ด'), Icons.qr_code_scanner),
          seg(
              ScanInputMode.rfid,
              rfidNote == null ? 'RFID' : 'RFID (${loc.t(rfidNote!)})',
              Icons.wifi_tethering),
        ],
      ),
    );
  }
}
