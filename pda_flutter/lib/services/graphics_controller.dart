import 'package:flutter/material.dart';

import '../theme.dart';
import 'prefs.dart';

/// Low-graphics / battery-saver toggle for the PDA app — mirrors
/// [ThemeController]'s shape exactly: owns the persisted preference, flips a
/// static flag on [C] on change, and notifies so the whole app rebuilds and
/// picks it up without per-widget plumbing. On, [C.shadow] and [C.anim] (see
/// theme.dart) strip drop-shadows and collapse screen-transition/toast
/// animation duration to zero app-wide — the two categories of effect this
/// codebase spends real compositor cost on (there's no real-time blur
/// anywhere in this app to worry about).
class GraphicsController extends ChangeNotifier {
  final Prefs prefs;
  GraphicsController(this.prefs) {
    C.lowGraphics = prefs.lowGraphicsMode;
  }

  bool get lowGraphics => C.lowGraphics;

  void set(bool v) {
    if (v == C.lowGraphics) return;
    C.lowGraphics = v;
    prefs.lowGraphicsMode = v;
    notifyListeners();
  }
}
