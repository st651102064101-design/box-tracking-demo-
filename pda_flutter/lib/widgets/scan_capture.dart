import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

/// Barcode input with no input box for the operator to get wrong.
///
/// ## Why this is a TextField and not a key handler
///
/// The obvious implementation — a [Focus] node with an `onKeyEvent` handler —
/// does not work on this hardware, and fails in the worst possible way: the
/// imager decodes, the terminal beeps, and nothing arrives. The decoded
/// barcode is delivered over the **text input connection**, the same channel
/// an on-screen keyboard uses, so only a live, focused, editable text input
/// ever sees it. A raw key handler is simply not on that path.
///
/// LoginScreen learned the neighbouring half of this the hard way (see its
/// `_captureField` doc): a zero-sized field establishes no connection at all
/// on web, because no DOM input is created, and again not one character
/// arrives. So the field here is real and fully laid out — it just paints
/// nothing.
///
/// ## Why the operator still cannot type into it
///
/// [TextInputType.none] means Android never raises a software keyboard for
/// this field, so there is no way to enter a code by hand on the handheld —
/// which is the entire point: a hand-typed box id or shelf code looks exactly
/// like a scanned one and is wrong in ways nobody notices until the box is
/// missing. [IgnorePointer] on top means a tap lands on whatever is behind it
/// instead of stealing focus. Web keeps a normal text connection, since a
/// desktop browser treats [TextInputType.none] as "no connection" and would
/// deliver nothing — there the developer keyboard is the only input there is.
///
/// The field is stacked *behind* [child] and given its box, so it costs no
/// layout: the screen above it is free to be a pure state display.
class ScanCapture extends StatefulWidget {
  final ValueChanged<String> onScan;

  /// False parks the capture — the field drops focus and takes nothing in.
  /// Used while a scan is being submitted, so a second trigger pull mid
  /// request can't start a second one.
  final bool enabled;

  final int minLength;
  final Widget child;

  const ScanCapture({
    super.key,
    required this.onScan,
    required this.child,
    this.enabled = true,
    this.minLength = 2,
  });

  @override
  State<ScanCapture> createState() => _ScanCaptureState();
}

class _ScanCaptureState extends State<ScanCapture> {
  final _ctrl = TextEditingController();
  final _focus = FocusNode(debugLabel: 'ScanCapture');
  Timer? _idle;
  int _prevLen = 0;

  /// Long enough to survive the gap between characters of one wedge burst,
  /// short enough that the scan feels instant. Same value the location and
  /// badge fields have always used.
  static const _idleGap = Duration(milliseconds: 180);

  @override
  void initState() {
    super.initState();
    // Focus is the whole contract here: an unfocused field receives nothing,
    // and there is no visible box for the operator to tap to fix that. So it
    // is taken on arrival and taken back whenever anything else drops it.
    _focus.addListener(_keepFocus);
    _arm();
  }

  @override
  void didUpdateWidget(ScanCapture old) {
    super.didUpdateWidget(old);
    if (widget.enabled && !old.enabled) {
      _ctrl.clear();
      _prevLen = 0;
      _arm();
    } else if (!widget.enabled && old.enabled) {
      _focus.unfocus();
    }
  }

  void _arm() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.enabled && !_focus.hasFocus) _focus.requestFocus();
    });
  }

  /// A dialog, a chip tap, a keyboard dismissal — anything can take focus, and
  /// on a screen with no visible field the operator has no way to notice it
  /// happened or to give it back. Every loss is therefore reclaimed.
  void _keepFocus() {
    if (!_focus.hasFocus) _arm();
  }

  @override
  void dispose() {
    _idle?.cancel();
    _focus.removeListener(_keepFocus);
    _ctrl.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Two-part termination, the same one every scan field in this app uses: a
  /// burst of characters arriving in a single callback is scanner speed no
  /// typist reaches and resolves at once; anything slower waits for the input
  /// to go quiet, because this engine does not reliably send a trailing Enter.
  void _onChanged(String v) {
    _idle?.cancel();
    final text = v.trim();
    final added = v.length - _prevLen;
    _prevLen = v.length;
    if (text.length < widget.minLength) return;
    if (added > 1) {
      _emit(text);
      return;
    }
    _idle = Timer(_idleGap, () {
      if (!mounted || _ctrl.text.trim() != text) return;
      _emit(text);
    });
  }

  void _emit(String code) {
    _idle?.cancel();
    _ctrl.clear();
    _prevLen = 0;
    if (!mounted || !widget.enabled) return;
    if (code.length < widget.minLength) return;
    widget.onScan(code);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        // Behind the content and pinned to its box: real layout (so the input
        // connection exists) with nothing painted (so there is no box to tap,
        // mistrust, or type into).
        Positioned.fill(
          child: IgnorePointer(
            child: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: double.infinity,
                height: 24,
                child: TextField(
                  controller: _ctrl,
                  focusNode: _focus,
                  enabled: widget.enabled,
                  autofocus: widget.enabled,
                  keyboardType: kIsWeb ? TextInputType.text : TextInputType.none,
                  autocorrect: false,
                  enableSuggestions: false,
                  enableInteractiveSelection: false,
                  showCursor: false,
                  textCapitalization: TextCapitalization.characters,
                  onChanged: _onChanged,
                  onSubmitted: (v) => _emit(v.trim()),
                  style: const TextStyle(
                      fontSize: 1, color: Color(0x00000000), height: 0.01),
                  decoration: const InputDecoration(
                      isCollapsed: true, border: InputBorder.none),
                ),
              ),
            ),
          ),
        ),
        widget.child,
      ],
    );
  }
}
