import 'package:flutter/material.dart';

import '../theme.dart';
import 'prefs.dart';

/// Light/dark toggle for the PDA app, mirroring the moon/sun switch already
/// used in the SmartTrace web reference — persists the choice like
/// [LocaleController] does for language, and re-applies [C]'s whole palette
/// on toggle so every screen re-themes without per-widget plumbing.
class ThemeController extends ChangeNotifier {
  final Prefs prefs;
  ThemeController(this.prefs) {
    C.apply(prefs.darkMode);
  }

  bool get isDark => C.isDark;

  void toggle() {
    C.apply(!C.isDark);
    prefs.darkMode = C.isDark;
    notifyListeners();
  }
}

/// Small round icon button, styled like [LangToggleButton] so the two sit
/// naturally side by side in a screen's header.
class ThemeToggleButton extends StatelessWidget {
  final ThemeController ctrl;
  const ThemeToggleButton({super.key, required this.ctrl});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: C.neutralBg,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: ctrl.toggle,
        child: Padding(
          padding: const EdgeInsets.all(9),
          child: Icon(
            ctrl.isDark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
            size: 18,
            color: C.ink2,
          ),
        ),
      ),
    );
  }
}
