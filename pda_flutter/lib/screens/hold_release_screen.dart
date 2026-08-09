import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../models/box.dart';
import '../services/api_client.dart';
import '../services/i18n.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/scan_capture.dart';

/// "พัก / แจ้งชำรุด" — the only way to hold, flag damaged, or release a box
/// any time other than at Gate In receiving (see scan_screen.dart's own
/// _ConditionPicker for that path). Backed by POST /api/boxes/:tag/hold.
///
/// Two steps, same shape as every other scan-then-act screen in this app:
/// scan the box, then act on whichever of the three status buttons applies
/// to the status it's actually in right now — never all three, since e.g.
/// offering "Hold" on a box that's already held is a request the server
/// would just refuse (409 status_unchanged).
class HoldReleaseScreen extends StatefulWidget {
  const HoldReleaseScreen({super.key});
  @override
  State<HoldReleaseScreen> createState() => _HoldReleaseScreenState();
}

class _HoldReleaseScreenState extends State<HoldReleaseScreen> {
  Box? _box;
  String? _scanError;
  bool _busy = false;
  String? _actionError;

  void _onScan(AppController c, String raw) {
    final s = c.S;
    if (s == null) return;
    final b = s.box(c.resolveTag(raw));
    if (b == null) {
      setState(() => _scanError = 'ไม่พบกล่องรหัส "$raw"');
      return;
    }
    if (!['warehouse', 'hold', 'damage'].contains(b.status)) {
      setState(() => _scanError =
          '${b.tag} สถานะ "${StatusMeta.of(b.status).label}" — พัก/แจ้งชำรุดได้เฉพาะกล่องที่อยู่ในคลังเท่านั้น');
      return;
    }
    setState(() {
      _scanError = null;
      _actionError = null;
      _box = b;
    });
  }

  Future<void> _act(AppController c, String status) async {
    final b = _box;
    if (b == null || _busy) return;
    final loc = context.read<LocaleController>();
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      await c.api.setBoxHold(b.tag, status: status);
      if (!mounted) return;
      final label = switch (status) {
        'hold' => 'พักสินค้าแล้ว',
        'damage' => 'แจ้งชำรุดแล้ว',
        _ => 'ปลดพักแล้ว — กลับเป็นปกติ',
      };
      c.toastMsg(label, b.tag, ResultKind.ok);
      await c.refresh();
      if (!mounted) return;
      setState(() {
        _box = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _actionError =
          e is ApiException ? e.message : loc.t('บันทึกไม่สำเร็จ'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    final loc = context.watch<LocaleController>();
    final bottom = MediaQuery.of(context).padding.bottom;
    final box = _box;

    return ScanCapture(
      enabled: box == null && !_busy,
      onScan: (raw) => _onScan(c, raw),
      child: AutoHideHeader(
        header: StickyHeader(
          onBack:
              box == null ? c.backToHome : () => setState(() => _box = null),
          title: Text(loc.t('พัก / แจ้งชำรุด')),
          subtitle:
              Text(loc.t(box == null ? 'ยิงบาร์โค้ดกล่อง' : 'เลือกการทำงาน')),
        ),
        body: ListView(
          padding: EdgeInsets.fromLTRB(16, 15, 16, bottom + 20),
          children: box == null ? _scanBody(loc) : _actionBody(c, loc, box),
        ),
      ),
    );
  }

  List<Widget> _scanBody(LocaleController loc) => [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 22),
          decoration: BoxDecoration(
            color: C.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: C.fieldBorder, width: 1.5),
          ),
          child: Column(
            children: [
              Icon(Icons.qr_code_scanner, size: 26, color: C.muted),
              const SizedBox(height: 8),
              Text(loc.t('ยิงบาร์โค้ดกล่องที่จะพักหรือแจ้งชำรุด'),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      fontSize: 14,
                      color: C.muted,
                      fontWeight: FontWeight.w600)),
            ],
          ),
        ),
        if (_scanError != null) ...[
          const SizedBox(height: 10),
          Text(_scanError!,
              style: TextStyle(
                  fontSize: 13, color: C.red, fontWeight: FontWeight.w600)),
        ],
      ];

  List<Widget> _actionBody(AppController c, LocaleController loc, Box b) {
    final sm = StatusMeta.of(b.status);
    return [
      Panel(
        radius: 18,
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(b.tag,
                      style: const TextStyle(
                          fontSize: 22,
                          fontWeight: FontWeight.w800,
                          fontFamily: 'monospace')),
                ),
                Pill(sm.label, color: sm.color, bg: sm.bg),
              ],
            ),
            const SizedBox(height: 6),
            Text(c.S?.typeName(b.type) ?? '-',
                style: TextStyle(fontSize: 13, color: C.muted)),
            const SizedBox(height: 4),
            Text(locationText(b.location.map((k, v) => MapEntry(k, '$v'))),
                style: TextStyle(fontSize: 12.5, color: C.ink3)),
          ],
        ),
      ),
      const SizedBox(height: 16),
      if (b.status != 'hold')
        _actionButton(
          label: loc.t('พักสินค้า (Hold)'),
          icon: Icons.pause_circle_outline,
          color: C.orange,
          bg: C.orangeBg,
          onTap: () => _act(c, 'hold'),
        ),
      if (b.status != 'damage') ...[
        const SizedBox(height: 10),
        _actionButton(
          label: loc.t('แจ้งชำรุด'),
          icon: Icons.report_gmailerrorred_outlined,
          color: C.red,
          bg: C.redBg,
          onTap: () => _act(c, 'damage'),
        ),
      ],
      if (b.status != 'warehouse') ...[
        const SizedBox(height: 10),
        _actionButton(
          label: loc.t('ปลดพัก — กลับเป็นปกติ'),
          icon: Icons.check_circle_outline,
          color: C.limeText,
          bg: C.limeBg,
          onTap: () => _act(c, 'warehouse'),
        ),
      ],
      if (_actionError != null) ...[
        const SizedBox(height: 12),
        Text(_actionError!,
            style: TextStyle(
                fontSize: 13, color: C.red, fontWeight: FontWeight.w600)),
      ],
    ];
  }

  Widget _actionButton({
    required String label,
    required IconData icon,
    required Color color,
    required Color bg,
    required VoidCallback onTap,
  }) {
    return SizedBox(
      width: double.infinity,
      child: FilledButton.icon(
        onPressed: _busy ? null : onTap,
        icon: _busy
            ? const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2))
            : Icon(icon, size: 19, color: color),
        label: Text(label, style: TextStyle(color: color)),
        style: FilledButton.styleFrom(
          backgroundColor: bg,
          padding: const EdgeInsets.symmetric(vertical: 14),
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: BorderSide(color: color.withValues(alpha: 0.35))),
        ),
      ),
    );
  }
}
