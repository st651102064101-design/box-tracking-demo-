import 'dart:async';

/// Detects "this text field is being filled by a scanner" from keystroke
/// timing alone, so a free-text field can auto-submit a scan without a
/// trailing Enter/Tab keystroke — without also cutting a human off mid-word.
///
/// A keyboard-wedge scanner (barcode gun or the MC3390R's own RFID-to-text
/// path) injects a whole code in a handful of milliseconds, far faster than
/// anyone types by hand; some builds even deliver the entire code in one
/// `onChanged` callback instead of one call per keystroke. Both patterns are
/// scan-speed proof.
///
/// The critical rule (copied from LoginScreen's badge-scan detector, the
/// only place this was originally solved correctly — see its own comment
/// for the exact failure this avoids): **never arm a timer preemptively "in
/// case the next character comes fast."** Only arm it *after* actually
/// observing a scan-speed gap or a multi-character burst. That way a person
/// typing by hand — even one who pauses mid-code exactly like a scanner's
/// own inter-character gap would look, or types the first few characters in
/// a burst — can never get auto-submitted out from under them: the very
/// first human-speed gap latches [looksTyped] for the rest of that entry,
/// permanently disarming auto-submit until the field is cleared.
class ScanSpeedAutoSubmit {
  final void Function() onAutoSubmit;
  /// Below this inter-keystroke gap, the keystroke is scanner-speed.
  final int gapMs;
  /// How long the field must sit quiet after a scan-speed keystroke before
  /// auto-submitting — long enough for the scanner's remaining characters to
  /// land, short enough to feel instant.
  final int flushMs;
  final int minLen;

  ScanSpeedAutoSubmit({
    required this.onAutoSubmit,
    this.gapMs = 80,
    this.flushMs = 220,
    this.minLen = 1,
  });

  Timer? _flush;
  DateTime? _lastKeyAt;
  int _prevLen = 0;
  bool _looksTyped = false;

  /// Feed the field's latest full value on every `onChanged`.
  void onChanged(String value) {
    _flush?.cancel();
    if (value.isEmpty) {
      reset();
      return;
    }
    final now = DateTime.now();
    final addedChars = value.length - _prevLen;
    _prevLen = value.length;
    final prev = _lastKeyAt;
    _lastKeyAt = now;

    if (value.length < minLen) return;

    // Some keyboard-wedge builds deliver the whole scanned code in one
    // onChanged call — more than one new character in a single callback is
    // scan-speed proof on its own, the same as a fast inter-key gap below.
    if (addedChars > 1) {
      if (_looksTyped) return;
      _arm(value);
      return;
    }
    if (prev == null) return; // first character of this entry — no gap yet
    final gap = now.difference(prev).inMilliseconds;
    if (gap > gapMs) {
      _looksTyped = true; // a human-speed gap was just confirmed — latched
      return;
    }
    if (_looksTyped) return;
    _arm(value);
  }

  void _arm(String value) {
    _flush = Timer(Duration(milliseconds: flushMs), () {
      // Caller re-checks the field still holds exactly this value before
      // actually submitting (see track_screen.dart / rfid_register_screen.dart
      // for the pattern) — this timer firing is not itself proof nothing
      // changed since.
      onAutoSubmit();
    });
  }

  /// True once a human-speed gap has been seen in the current entry —
  /// exposed so a caller that wants to skip the "field unchanged" recheck
  /// dance can just trust this instead.
  bool get looksTyped => _looksTyped;

  void reset() {
    _flush?.cancel();
    _flush = null;
    _lastKeyAt = null;
    _prevLen = 0;
    _looksTyped = false;
  }

  void dispose() {
    _flush?.cancel();
  }
}
