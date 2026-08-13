import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import 'boot_screen.dart';
import 'login_screen.dart';
import 'device_setup_screen.dart';
import 'home_screen.dart';
import 'scan_screen.dart';
import 'track_screen.dart';
import 'settings_screen.dart';
import 'rfid_input_screen.dart';
import 'rfid_locate_screen.dart';
import 'box_register_screen.dart';
import 'transfer_screen.dart';
import 'cycle_count_screen.dart';
import 'more_hub_screen.dart';
import 'hold_release_screen.dart';
import 'location_inquiry_screen.dart';
import 'toast_overlay.dart';

/// Hosts the current screen inside a phone-width frame (max 560px, like the
/// mockup) and paints the toast overlay above everything.
class RootScreen extends StatelessWidget {
  const RootScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    // Scaffold reads scaffoldBackgroundColor from the Theme (set in buildTheme())
    // rather than hardcoding C.bg here — Theme propagates via its own
    // InheritedWidget mechanism, so this repaints on a dark/light toggle even
    // though RootScreen itself never watches ThemeController directly.
    //
    // canPop: false stops the framework's own pop — the 3-button nav bar's
    // ‹ and the edge-swipe gesture would otherwise exit the app outright
    // mid-scan, since there's no Navigator stack under here for them to pop
    // (screens are just AppController.screen swapping which widget
    // AnimatedSwitcher shows). onPopInvokedWithResult still fires on every
    // press even though the pop itself is blocked, which is what routes a
    // hardware back press into the exact same in-app navigation each
    // screen's own StickyHeader arrow already uses (see
    // AppController.handleSystemBack) — back always goes somewhere, it
    // just never leaves the app.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        c.handleSystemBack();
      },
      child: Scaffold(
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Stack(
              children: [
                Positioned.fill(
                  child: AnimatedSwitcher(
                    // Cross-fade is the single most-run animation in the
                    // app — every screen change plays it — so it's the
                    // first thing low power mode cuts, straight to an
                    // instant swap.
                    duration: c.lowPowerMode
                        ? Duration.zero
                        : const Duration(milliseconds: 220),
                    child: _body(c),
                  ),
                ),
                const ToastOverlay(),
                const _OfflineAlertListener(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _body(AppController c) {
    switch (c.screen) {
      case Screen.boot:
        return const BootScreen(key: ValueKey('boot'));
      case Screen.deviceSetup:
        return const DeviceSetupScreen(key: ValueKey('deviceSetup'));
      case Screen.login:
        return const LoginScreen(key: ValueKey('login'));
      case Screen.home:
        return const HomeScreen(key: ValueKey('home'));
      case Screen.scan:
        return const ScanScreen(key: ValueKey('scan'));
      case Screen.track:
        return const TrackScreen(key: ValueKey('track'));
      case Screen.settings:
        return const SettingsScreen(key: ValueKey('settings'));
      case Screen.rfidInput:
        return const RfidInputScreen(key: ValueKey('rfidInput'));
      case Screen.rfidLocate:
        return const RfidLocateScreen(key: ValueKey('rfidLocate'));
      case Screen.boxRegister:
        return const BoxRegisterScreen(key: ValueKey('boxRegister'));
      case Screen.transfer:
        return const TransferScreen(key: ValueKey('transfer'));
      case Screen.cycleCount:
        return const CycleCountScreen(key: ValueKey('cycleCount'));
      case Screen.moreHub:
        return const MoreHubScreen(key: ValueKey('moreHub'));
      case Screen.holdRelease:
        return const HoldReleaseScreen(key: ValueKey('holdRelease'));
      case Screen.locationInquiry:
        return const LocationInquiryScreen(key: ValueKey('locationInquiry'));
    }
  }
}

/// Invisible — its only job is to pop a one-shot AlertDialog whenever
/// AppController.offlineEventId ticks (a realtime SSE-detected connectivity
/// drop, see AppController._onRealtimeConnectivity), regardless of which
/// screen happens to be on top. A plain `context.watch` in build() would
/// refire on every unrelated notifyListeners() call across the whole app;
/// comparing against the last-seen id here is what keeps this to exactly
/// one dialog per actual drop.
class _OfflineAlertListener extends StatefulWidget {
  const _OfflineAlertListener();
  @override
  State<_OfflineAlertListener> createState() => _OfflineAlertListenerState();
}

class _OfflineAlertListenerState extends State<_OfflineAlertListener> {
  int? _lastSeen;
  bool _dialogOpen = false;

  @override
  Widget build(BuildContext context) {
    final id = context.select<AppController, int>((c) => c.offlineEventId);
    final connected = context.select<AppController, bool>((c) => c.connected);
    if (_lastSeen == null) {
      // First build: this is the app's starting state, not a drop that just
      // happened — nothing to alert about yet.
      _lastSeen = id;
    } else if (id != _lastSeen) {
      _lastSeen = id;
      final c = context.read<AppController>();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _dialogOpen = true;
        showDialog<void>(
          context: context,
          builder: (dialogCtx) => AlertDialog(
            title: const Text('ขาดการเชื่อมต่อกับระบบหลัก'),
            content: Text(
              c.connError ??
                  'ระบบจะลองเชื่อมต่อใหม่อัตโนมัติ — ข้อมูลที่ยิงระหว่างนี้จะถูกพักคิวไว้',
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.of(dialogCtx).pop(),
                  child: const Text('รับทราบ')),
              FilledButton(
                onPressed: () {
                  Navigator.of(dialogCtx).pop();
                  c.goDeviceSetup();
                },
                child: const Text('ตั้งค่าระบบ'),
              ),
            ],
          ),
        ).then((_) => _dialogOpen = false);
      });
    }
    // The dialog has no auto-close timer of its own — it stays up until the
    // operator taps a button. Reconnecting in the background (the SSE retry
    // succeeding, or a manual "ตั้งค่าระบบ" fix landing) must still clear it
    // immediately rather than leaving a stale "ขาดการเชื่อมต่อ" dialog on
    // screen once the app is actually back online.
    if (connected && _dialogOpen) {
      _dialogOpen = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        Navigator.of(context, rootNavigator: true).maybePop();
      });
    }
    // Must be Positioned, not a bare SizedBox: a Stack sizes itself to its
    // largest *non*-positioned child, so an unpositioned 0x0 widget here
    // collapses the whole Stack to 0x0 — and then the Positioned.fill
    // holding the actual screen fills nothing, rendering the app black with
    // no error anywhere. Same reason ToastOverlay returns a Positioned.
    return const Positioned(width: 0, height: 0, child: SizedBox.shrink());
  }
}
