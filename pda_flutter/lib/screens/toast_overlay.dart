import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../theme.dart';

class ToastOverlay extends StatelessWidget {
  const ToastOverlay({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.select<AppController, Toast?>((c) => c.toast);
    final bottom = MediaQuery.of(context).padding.bottom;
    return Positioned(
      left: 0,
      right: 0,
      bottom: bottom + 26,
      child: IgnorePointer(
        child: AnimatedSwitcher(
          duration: C.anim(const Duration(milliseconds: 220)),
          transitionBuilder: (child, anim) => FadeTransition(
            opacity: anim,
            child: SlideTransition(
              position: Tween(begin: const Offset(0, 0.4), end: Offset.zero).animate(
                CurvedAnimation(parent: anim, curve: Curves.easeOutCubic),
              ),
              child: child,
            ),
          ),
          child: t == null ? const SizedBox.shrink() : _Toast(t, key: ValueKey(t)),
        ),
      ),
    );
  }
}

class _Toast extends StatelessWidget {
  final Toast toast;
  const _Toast(this.toast, {super.key});

  @override
  Widget build(BuildContext context) {
    // Every toast background inverts with the theme — ink goes near-white in
    // dark mode, and red/orange go from deep to bright — so the text on top has
    // to invert with them. C.onInk is exactly that flip, which is why it suits
    // the coloured toasts as well as the ink ones.
    late Color bg, dot;
    final fg = C.onInk;
    switch (toast.kind) {
      case ResultKind.ok:
        bg = C.ink;
        dot = C.lime;
        break;
      case ResultKind.err:
        bg = C.red;
        dot = fg;
        break;
      case ResultKind.warn:
        bg = C.orange;
        dot = fg;
        break;
      case ResultKind.info:
        bg = C.ink2;
        dot = C.lime;
        break;
    }
    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.88),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(15),
            boxShadow: C.shadow([BoxShadow(color: Colors.black.withOpacity(0.3), blurRadius: 40, offset: const Offset(0, 12))]),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(width: 9, height: 9, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
              const SizedBox(width: 11),
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(toast.title,
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: fg, height: 1.25)),
                    if (toast.sub.isNotEmpty)
                      Text(toast.sub,
                          style: TextStyle(fontSize: 12.5, color: fg.withValues(alpha: 0.75))),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
