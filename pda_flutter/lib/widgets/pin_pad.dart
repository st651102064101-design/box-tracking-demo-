import 'package:flutter/material.dart';

import '../theme.dart';

/// Result of a PIN sheet: either a completed code, or the operator chose to
/// skip (only possible when the sheet was opened with [allowSkip]).
class PinResult {
  final String? pin;
  final bool skipped;
  const PinResult._(this.pin, this.skipped);
  const PinResult.entered(String pin) : this._(pin, false);
  const PinResult.skipped() : this._(null, true);
}

/// A numeric keypad sheet — [length] digits (4 for a PIN, 6 for an OTP).
/// [validate] is awaited before the sheet closes, so it can round-trip to the
/// backend (PIN checks live server-side, never on the device); return an
/// error message to reject and let the operator try again, or null to accept.
/// [allowSkip] only makes sense while *setting* a PIN — an employee who
/// already committed to one can't opt out of entering it later.
Future<PinResult?> showPinPad(
  BuildContext context, {
  required String title,
  String? subtitle,
  int length = 4,
  bool allowSkip = false,
  Future<String?> Function(String pin)? validate,
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
      validate: validate,
    ),
  );
}

class _PinPadSheet extends StatefulWidget {
  final String title;
  final String? subtitle;
  final int length;
  final bool allowSkip;
  final Future<String?> Function(String pin)? validate;
  const _PinPadSheet({
    required this.title,
    this.subtitle,
    required this.length,
    required this.allowSkip,
    this.validate,
  });

  @override
  State<_PinPadSheet> createState() => _PinPadSheetState();
}

class _PinPadSheetState extends State<_PinPadSheet> {
  String _digits = '';
  String? _error;
  bool _checking = false;

  void _tap(String d) {
    if (_checking || _digits.length >= widget.length) return;
    setState(() {
      _error = null;
      _digits += d;
    });
    if (_digits.length == widget.length) _submit();
  }

  void _backspace() {
    if (_checking || _digits.isEmpty) return;
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
            decoration: BoxDecoration(color: C.border2, borderRadius: BorderRadius.circular(2)),
          ),
          Text(widget.title,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: C.ink)),
          if (widget.subtitle != null) ...[
            const SizedBox(height: 6),
            Text(widget.subtitle!,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, color: C.muted, height: 1.4)),
          ],
          const SizedBox(height: 22),
          SizedBox(
            height: 16,
            child: _checking
                ? Center(
                    child: SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2, color: C.ink2),
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
                          border: Border.all(color: _error != null ? C.red : C.border2, width: 1.5),
                        ),
                      );
                    }),
                  ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: TextStyle(fontSize: 12.5, color: C.red, fontWeight: FontWeight.w600)),
          ],
          const SizedBox(height: 24),
          IgnorePointer(
            ignoring: _checking,
            child: Opacity(
              opacity: _checking ? 0.4 : 1,
              child: _Keypad(onDigit: _tap, onBackspace: _backspace),
            ),
          ),
          if (widget.allowSkip) ...[
            const SizedBox(height: 12),
            TextButton(
              onPressed: _checking ? null : () => Navigator.of(context).pop(const PinResult.skipped()),
              child: const Text('ข้าม / ไม่ตั้ง PIN'),
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
                                  ? Icon(Icons.backspace_outlined, size: 20, color: C.ink2)
                                  : Text(k, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: C.ink)),
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
