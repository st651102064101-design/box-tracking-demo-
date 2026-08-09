import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Barcode input with no text field on screen.
///
/// This terminal's imager is a keyboard wedge: pressing the side scan button
/// makes the engine type the decoded barcode as ordinary key events. Every
/// screen used to catch those with a visible [TextField], which is why they
/// all had to worry about focus, a soft keyboard covering half the screen, and
/// an operator having to tap the right box before a scan would land anywhere.
///
/// A focus node with a raw key handler catches exactly the same keystrokes
/// without being editable, so nothing is drawn, no keyboard opens, and there
/// is no focus for the operator to lose or restore. The state machine above it
/// decides what a scan *means* right now — see ScanScreen.
///
/// Termination is the same two-part rule the old fields used: a trailing
/// Enter/Tab ends the scan immediately when the engine is configured to send
/// one, and otherwise the burst is taken as finished once the keystrokes go
/// quiet. [minLength] drops the stray single keypress that is never a barcode.
class ScanCapture extends StatefulWidget {
  final ValueChanged<String> onScan;

  /// False parks the capture — keystrokes pass through untouched. Used while
  /// a scan is being submitted, so a second trigger pull mid-request can't
  /// start a second one.
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
  final _node = FocusNode(debugLabel: 'ScanCapture');
  final _buf = StringBuffer();
  Timer? _idle;

  /// Long enough to survive the gap between keystrokes of one wedge burst,
  /// short enough that the scan feels instant. The engine types far faster
  /// than this; a human never types a whole code inside it.
  static const _idleGap = Duration(milliseconds: 140);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.enabled) _node.requestFocus();
    });
  }

  @override
  void didUpdateWidget(ScanCapture old) {
    super.didUpdateWidget(old);
    // Re-arming after a submit: take focus back, or the next scan lands
    // nowhere and looks like a dead trigger.
    if (widget.enabled && !old.enabled) {
      _buf.clear();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && widget.enabled) _node.requestFocus();
      });
    }
  }

  @override
  void dispose() {
    _idle?.cancel();
    _node.dispose();
    super.dispose();
  }

  void _emit() {
    _idle?.cancel();
    final code = _buf.toString().trim();
    _buf.clear();
    if (code.length < widget.minLength) return;
    if (!mounted || !widget.enabled) return;
    widget.onScan(code);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (!widget.enabled) return KeyEventResult.ignored;
    // Key-up carries the same logical key as its key-down; acting on both
    // would double every character.
    if (e is KeyUpEvent) return KeyEventResult.ignored;
    final k = e.logicalKey;
    if (k == LogicalKeyboardKey.enter ||
        k == LogicalKeyboardKey.numpadEnter ||
        k == LogicalKeyboardKey.tab) {
      _emit();
      return KeyEventResult.handled;
    }
    final ch = e.character;
    if (ch == null || ch.isEmpty) return KeyEventResult.ignored;
    if (ch == '\n' || ch == '\r' || ch == '\t') {
      _emit();
      return KeyEventResult.handled;
    }
    // Control characters aren't part of any code the engine sends.
    if (ch.codeUnitAt(0) < 0x20) return KeyEventResult.ignored;
    _buf.write(ch);
    _idle?.cancel();
    _idle = Timer(_idleGap, _emit);
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      focusNode: _node,
      autofocus: widget.enabled,
      onKeyEvent: _onKey,
      child: widget.child,
    );
  }
}
