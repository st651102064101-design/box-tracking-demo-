import 'package:flutter/material.dart';
import '../theme.dart';

class BootScreen extends StatelessWidget {
  const BootScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return Container(
      color: C.bg,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(40),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 78,
            height: 78,
            decoration: BoxDecoration(color: C.ink, borderRadius: BorderRadius.circular(20)),
            alignment: Alignment.center,
            child: const Text('◈', style: TextStyle(color: C.lime, fontSize: 38, fontWeight: FontWeight.w800)),
          ),
          const SizedBox(height: 18),
          const Text.rich(
            TextSpan(
              style: TextStyle(fontSize: 23, fontWeight: FontWeight.w700, letterSpacing: -0.6, color: C.ink),
              children: [
                TextSpan(text: 'BoxTrace '),
                TextSpan(text: 'PDA', style: TextStyle(color: C.limeText)),
              ],
            ),
          ),
          const SizedBox(height: 2),
          const Text('Zebra MC3390R · Handheld Terminal',
              style: TextStyle(fontSize: 13, color: C.muted)),
          const SizedBox(height: 18),
          const SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2.5, color: C.ink),
          ),
        ],
      ),
    );
  }
}
