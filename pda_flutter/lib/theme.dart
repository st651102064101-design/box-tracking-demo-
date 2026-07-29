import 'package:flutter/material.dart';

/// Design tokens ported 1:1 from the "BoxTrace PDA (offline)" mockup so the
/// Flutter build reads identically to the reference handheld UI.
///
/// Mutable (not `static const`) so [apply] can swap the whole palette for
/// dark mode at runtime — every existing `C.xxx` reference elsewhere in the
/// app just picks up the new value on the next rebuild, no per-widget theme
/// plumbing needed.
class C {
  static bool isDark = false;

  // surfaces
  static Color bg = const Color(0xFFF5F5F7);
  static Color surface = const Color(0xFFFFFFFF);
  static Color ink = const Color(0xFF1D1D1F); // near-black brand
  static Color ink2 = const Color(0xFF3A3A3C);
  static Color ink3 = const Color(0xFF424245);

  /// Foreground for anything painted *on* [ink] or [ink2] — the badge prompt,
  /// a filled action card, a selected chip.
  ///
  /// Those tokens invert between themes (near-black in light, near-white in
  /// dark), so a hardcoded white on top of them vanishes the moment dark mode
  /// is on. This inverts with them, which is why every such surface should
  /// reach for it instead of [Colors.white].
  static Color onInk = const Color(0xFFFFFFFF);

  // text / muted
  static Color muted = const Color(0xFF86868B);
  static Color faint = const Color(0xFFAEAEB2);
  static Color chevron = const Color(0xFFC7C7CC);

  // borders
  static Color border = const Color(0xFFE3E3E8);
  static Color border2 = const Color(0xFFD2D2D7);
  static Color fieldBorder = const Color(0xFFC7C7CC);

  // lime accent (primary action / "ok")
  static Color lime = const Color(0xFFA8F931);
  static Color limeDeep = const Color(0xFF16330A);
  static Color limeText = const Color(0xFF4D7A0A);
  static Color limeBg = const Color(0xFFEEFCCB);
  static Color limeBorder = const Color(0xFFC3EE7E);

  // orange (out / warning)
  static Color orange = const Color(0xFFBF5D00);
  static Color orangeBg = const Color(0xFFFFF2E0);
  static Color orangeBorder = const Color(0xFFFFD9A8);

  // red (lost / damage / error)
  static Color red = const Color(0xFFD70015);
  static Color redBg = const Color(0xFFFFECEB);
  static Color redBorder = const Color(0xFFFFC9C4);

  // neutral chips
  static Color neutralBg = const Color(0xFFECEEEF);
  static Color neutralBg2 = const Color(0xFFF0F0F2);

  /// Swap every token to its light or dark value in one shot.
  static void apply(bool dark) {
    isDark = dark;
    bg = dark ? const Color(0xFF0B0B0C) : const Color(0xFFF5F5F7);
    surface = dark ? const Color(0xFF1C1C1E) : const Color(0xFFFFFFFF);
    ink = dark ? const Color(0xFFF5F5F7) : const Color(0xFF1D1D1F);
    ink2 = dark ? const Color(0xFFD1D1D6) : const Color(0xFF3A3A3C);
    ink3 = dark ? const Color(0xFFC7C7CC) : const Color(0xFF424245);
    onInk = dark ? const Color(0xFF1D1D1F) : const Color(0xFFFFFFFF);

    muted = dark ? const Color(0xFF98989D) : const Color(0xFF86868B);
    faint = dark ? const Color(0xFF6E6E73) : const Color(0xFFAEAEB2);
    chevron = dark ? const Color(0xFF48484A) : const Color(0xFFC7C7CC);

    border = dark ? const Color(0xFF2C2C2E) : const Color(0xFFE3E3E8);
    border2 = dark ? const Color(0xFF3A3A3C) : const Color(0xFFD2D2D7);
    fieldBorder = dark ? const Color(0xFF48484A) : const Color(0xFFC7C7CC);

    lime = const Color(0xFFA8F931);
    limeDeep = const Color(0xFF16330A);
    limeText = dark ? const Color(0xFF9AE64A) : const Color(0xFF4D7A0A);
    limeBg = dark ? const Color(0xFF1E2A08) : const Color(0xFFEEFCCB);
    limeBorder = dark ? const Color(0xFF3A5511) : const Color(0xFFC3EE7E);

    orange = dark ? const Color(0xFFFF9F0A) : const Color(0xFFBF5D00);
    orangeBg = dark ? const Color(0xFF3A2A12) : const Color(0xFFFFF2E0);
    orangeBorder = dark ? const Color(0xFF5C4420) : const Color(0xFFFFD9A8);

    red = dark ? const Color(0xFFFF453A) : const Color(0xFFD70015);
    redBg = dark ? const Color(0xFF3A1210) : const Color(0xFFFFECEB);
    redBorder = dark ? const Color(0xFF5C201C) : const Color(0xFFFFC9C4);

    neutralBg = dark ? const Color(0xFF2C2C2E) : const Color(0xFFECEEEF);
    neutralBg2 = dark ? const Color(0xFF242426) : const Color(0xFFF0F0F2);
  }
}

/// The mono family used for tags/codes in the mockup.
const kMono = [
  'SF Mono',
  'ui-monospace',
  'Menlo',
  'monospace',
];

ThemeData buildTheme() {
  final base = ThemeData(
    useMaterial3: true,
    scaffoldBackgroundColor: C.bg,
    colorScheme: ColorScheme.fromSeed(
      seedColor: C.ink,
      primary: C.ink,
      surface: C.surface,
      brightness: C.isDark ? Brightness.dark : Brightness.light,
    ),
    splashFactory: InkRipple.splashFactory,
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(
      bodyColor: C.ink,
      displayColor: C.ink,
      // Anuphan (Thai) can be dropped into assets and referenced here; the
      // system font already renders Thai fine on the device.
    ),
  );
}

/// Status colour + label mapping — mirror of `statusMeta()` in the mockup.
class StatusMeta {
  final String label;
  final Color color;
  final Color bg;
  const StatusMeta(this.label, this.color, this.bg);

  static StatusMeta of(String? s) {
    switch (s) {
      case 'warehouse':
        return StatusMeta('ในคลัง', C.ink2, C.neutralBg);
      case 'out':
        return StatusMeta('ออกอยู่', C.orange, C.orangeBg);
      case 'lost':
        return StatusMeta('สูญหาย', C.red, C.redBg);
      case 'hold':
        return StatusMeta('พัก (Hold)', C.orange, C.orangeBg);
      case 'damage':
        return StatusMeta('ชำรุด', C.red, C.redBg);
      case 'pending':
        return StatusMeta('รอเข้าคลัง', C.muted, C.neutralBg2);
      default:
        return StatusMeta(s ?? '-', C.muted, C.neutralBg2);
    }
  }
}
