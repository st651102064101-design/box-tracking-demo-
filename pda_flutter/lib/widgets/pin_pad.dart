import 'package:flutter/material.dart';

import '../theme.dart';

/// Result of a PIN sheet: either a completed code, or the operator chose to
/// skip (only possible when the sheet was opened with [allowSkip]) or asked
/// to reset (only possible when the sheet was opened with [showForgot]).
class PinResult {
  final String? pin;
  final bool skipped;
  final bool forgot;
  const PinResult._(this.pin, this.skipped, this.forgot);
  const PinResult.entered(String pin) : this._(pin, false, false);
  const PinResult.skipped() : this._(null, true, false);
  const PinResult.forgot() : this._(null, false, true);
}

/// A numeric keypad sheet — [length] digits (4 for a PIN, 6 for an OTP).
/// [validate] is awaited before the sheet closes, so it can round-trip to the
/// backend (PIN checks live server-side, never on the device); return an
/// error message to reject and let the operator try again, or null to accept.
/// [allowSkip] only makes sense while *setting* a PIN — an employee who
/// already committed to one can't opt out of entering it later, but they can
/// tap "ลืมรหัส PIN?" instead when [showForgot] is set.
/// [onForgot], when given, runs when "ลืมรหัส PIN?" is tapped: the sheet
/// stays open and shows a busy state for the whole call (instead of popping
/// immediately and leaving the caller to show its own loading UI over a
/// blank screen) and only pops once it resolves. Return null on success or
/// an error message to keep the sheet open and let the operator retry.
Future<PinResult?> showPinPad(
  BuildContext context, {
  required String title,
  String? subtitle,
  int length = 4,
  bool allowSkip = false,
  bool showForgot = false,
  Future<String?> Function(String pin)? validate,
  Future<String?> Function()? onForgot,
}) {
  return showModalBottomSheet<PinResult>(
    context: context,
    backgroundColor: Colors.transparent,
    isDismissible: true,
    isScrollControlled: true,
    builder: (ctx) => _PinPadSheet(
      title: title,
      subtitle: subtitle,
      length: length,
      allowSkip: allowSkip,
      showForgot: showForgot,
      validate: validate,
      onForgot: onForgot,
    ),
  );
}

class _PinPadSheet extends StatefulWidget {
  final String title;
  final String? subtitle;
  final int length;
  final bool allowSkip;
  final bool showForgot;
  final Future<String?> Function(String pin)? validate;
  final Future<String?> Function()? onForgot;
  const _PinPadSheet({
    required this.title,
    this.subtitle,
    required this.length,
    required this.allowSkip,
    required this.showForgot,
    this.validate,
    this.onForgot,
  });

  @override
  State<_PinPadSheet> createState() => _PinPadSheetState();
}

class _PinPadSheetState extends State<_PinPadSheet> {
  String _digits = '';
  String? _error;
  bool _checking = false;
  // True while the "ลืมรหัส PIN?" network round-trip is in flight. Kept
  // separate from _checking so the busy label can say something more
  // specific than the plain PIN-check spinner.
  bool _forgotBusy = false;

  bool get _busy => _checking || _forgotBusy;

  void _tap(String d) {
    if (_busy || _digits.length >= widget.length) return;
    setState(() {
      _error = null;
      _digits += d;
    });
    if (_digits.length == widget.length) _submit();
  }

  void _backspace() {
    if (_busy || _digits.isEmpty) return;
    setState(() => _digits = _digits.substring(0, _digits.length - 1));
  }

  Future<void> _submit() async {
    if (widget.validate == null) {
      Navigator.of(context).pop(PinResult.entered(_digits));
      return;
    }
    setState(() => _checking = true);
    final err = await widget.validate!(_digits);
    if (!mounted) return;
    if (err != null) {
      setState(() {
        _error = err;
        _digits = '';
        _checking = false;
      });
      return;
    }
    Navigator.of(context).pop(PinResult.entered(_digits));
  }

  /// Tapping "ลืมรหัส PIN?" used to pop this sheet immediately, leaving the
  /// screen behind it silent and idle for however long the OTP request took
  /// — from the outside indistinguishable from the sheet just closing for no
  /// reason. Now the sheet stays open and shows it's doing something (spinner
  /// + status line) for the whole round trip, and only closes once the next
  /// step is actually ready to show — one continuous motion instead of
  /// close-then-blank-wait-then-reopen.
  Future<void> _tapForgot() async {
    if (_busy) return;
    if (widget.onForgot == null) {
      Navigator.of(context).pop(const PinResult.forgot());
      return;
    }
    setState(() {
      _error = null;
      _forgotBusy = true;
    });
    final err = await widget.onForgot!();
    if (!mounted) return;
    if (err != null) {
      setState(() {
        _error = err;
        _forgotBusy = false;
      });
      return;
    }
    Navigator.of(context).pop(const PinResult.forgot());
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).padding.bottom;
    return Container(
      padding: EdgeInsets.fromLTRB(22, 22, 22, bottom + 18),
      decoration: BoxDecoration(
        color: C.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 36,
            height: 4,
            margin: const EdgeInsets.only(bottom: 18),
            decoration: BoxDecoration(
                color: C.border2, borderRadius: BorderRadius.circular(2)),
          ),
          Text(widget.title,
              textAlign: TextAlign.center,
              style: TextStyle(
                  fontSize: 17, fontWeight: FontWeight.w700, color: C.ink)),
          if (widget.subtitle != null) ...[
            const SizedBox(height: 6),
            Text(widget.subtitle!,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, color: C.muted, height: 1.4)),
          ],
          const SizedBox(height: 22),
          SizedBox(
            height: 16,
            child: _busy
                ? Center(
                    child: SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: C.ink2),
                    ),
                  )
                : Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: List.generate(widget.length, (i) {
                      final filled = i < _digits.length;
                      return Container(
                        width: 16,
                        height: 16,
                        margin: const EdgeInsets.symmetric(horizontal: 8),
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: filled ? C.ink : Colors.transparent,
                          border: Border.all(
                              color: _error != null ? C.red : C.border2,
                              width: 1.5),
                        ),
                      );
                    }),
                  ),
          ),
          if (_forgotBusy) ...[
            const SizedBox(height: 10),
            Text('กำลังส่งรหัส OTP…',
                style: TextStyle(fontSize: 12.5, color: C.muted)),
          ],
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!,
                style: TextStyle(
                    fontSize: 12.5, color: C.red, fontWeight: FontWeight.w600)),
          ],
          const SizedBox(height: 24),
          IgnorePointer(
            ignoring: _busy,
            child: Opacity(
              opacity: _busy ? 0.4 : 1,
              child: _Keypad(onDigit: _tap, onBackspace: _backspace),
            ),
          ),
          if (widget.allowSkip) ...[
            const SizedBox(height: 12),
            TextButton(
              onPressed: _busy
                  ? null
                  : () => Navigator.of(context).pop(const PinResult.skipped()),
              child: const Text('ข้าม / ไม่ตั้ง PIN'),
            ),
          ],
          if (widget.showForgot) ...[
            const SizedBox(height: 4),
            TextButton(
              onPressed: _busy ? null : _tapForgot,
              child: const Text('ลืมรหัส PIN?'),
            ),
          ],
        ],
      ),
    );
  }
}

class _Keypad extends StatelessWidget {
  final ValueChanged<String> onDigit;
  final VoidCallback onBackspace;
  const _Keypad({required this.onDigit, required this.onBackspace});

  static const _rows = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['', '0', '⌫'],
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: _rows
          .map((row) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: row.map((k) {
                    if (k.isEmpty) {
                      return const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 8),
                        child: SizedBox(width: 72, height: 56),
                      );
                    }
                    final isBackspace = k == '⌫';
                    return Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      child: Material(
                        color: Colors.transparent,
                        shape: const CircleBorder(),
                        child: InkWell(
                          customBorder: const CircleBorder(),
                          onTap: isBackspace ? onBackspace : () => onDigit(k),
                          child: SizedBox(
                            width: 72,
                            height: 56,
                            child: Center(
                              child: isBackspace
                                  ? Icon(Icons.backspace_outlined,
                                      size: 20, color: C.ink2)
                                  : Text(k,
                                      style: TextStyle(
                                          fontSize: 22,
                                          fontWeight: FontWeight.w600,
                                          color: C.ink)),
                            ),
                          ),
                        ),
                      ),
                    );
                  }).toList(),
                ),
              ))
          .toList(),
    );
  }
}
