import 'package:flutter/material.dart';

/// Design tokens ported 1:1 from the "BoxTrace PDA (offline)" mockup so the
/// Flutter build reads identically to the reference handheld UI.
class C {
  // surfaces
  static const bg = Color(0xFFF5F5F7);
  static const surface = Color(0xFFFFFFFF);
  static const ink = Color(0xFF1D1D1F); // near-black brand
  static const ink2 = Color(0xFF3A3A3C);
  static const ink3 = Color(0xFF424245);

  // text / muted
  static const muted = Color(0xFF86868B);
  static const faint = Color(0xFFAEAEB2);
  static const chevron = Color(0xFFC7C7CC);

  // borders
  static const border = Color(0xFFE3E3E8);
  static const border2 = Color(0xFFD2D2D7);
  static const fieldBorder = Color(0xFFC7C7CC);

  // lime accent (primary action / "ok")
  static const lime = Color(0xFFA8F931);
  static const limeDeep = Color(0xFF16330A);
  static const limeText = Color(0xFF4D7A0A);
  static const limeBg = Color(0xFFEEFCCB);
  static const limeBorder = Color(0xFFC3EE7E);

  // orange (out / warning)
  static const orange = Color(0xFFBF5D00);
  static const orangeBg = Color(0xFFFFF2E0);
  static const orangeBorder = Color(0xFFFFD9A8);

  // red (lost / damage / error)
  static const red = Color(0xFFD70015);
  static const redBg = Color(0xFFFFECEB);
  static const redBorder = Color(0xFFFFC9C4);

  // neutral chips
  static const neutralBg = Color(0xFFECEEEF);
  static const neutralBg2 = Color(0xFFF0F0F2);
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
      background: C.bg,
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
        return const StatusMeta('ในคลัง', C.ink2, C.neutralBg);
      case 'out':
        return const StatusMeta('ออกอยู่', C.orange, C.orangeBg);
      case 'lost':
        return const StatusMeta('สูญหาย', C.red, C.redBg);
      case 'hold':
        return const StatusMeta('พัก (Hold)', C.orange, C.orangeBg);
      case 'damage':
        return const StatusMeta('ชำรุด', C.red, C.redBg);
      case 'pending':
        return const StatusMeta('รอเข้าคลัง', C.muted, C.neutralBg2);
      default:
        return StatusMeta(s ?? '-', C.muted, C.neutralBg2);
    }
  }
}
