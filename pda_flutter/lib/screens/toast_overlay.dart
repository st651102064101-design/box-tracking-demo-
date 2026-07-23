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
          duration: const Duration(milliseconds: 220),
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
    late Color bg, dot;
    switch (toast.kind) {
      case ResultKind.ok:
        bg = C.ink;
        dot = C.lime;
        break;
      case ResultKind.err:
        bg = C.red;
        dot = Colors.white;
        break;
      case ResultKind.warn:
        bg = C.orange;
        dot = Colors.white;
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
            boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.3), blurRadius: 40, offset: const Offset(0, 12))],
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
                        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: Colors.white, height: 1.25)),
                    if (toast.sub.isNotEmpty)
                      Text(toast.sub,
                          style: TextStyle(fontSize: 12.5, color: Colors.white.withOpacity(0.75))),
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
