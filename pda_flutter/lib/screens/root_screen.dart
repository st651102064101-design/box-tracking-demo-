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
import 'rfid_register_screen.dart';
import 'rfid_locate_screen.dart';
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
    // canPop: false blocks the Android system back control entirely — the
    // 3-button nav bar's ‹, and the edge-swipe gesture on gesture-nav
    // devices — on every screen, not just this one: there's no Navigator
    // stack under here for it to pop (screens are just AppController.screen
    // swapping which const widget AnimatedSwitcher shows), so an unblocked
    // back would either do nothing useful or exit the app outright mid-scan.
    // In-app navigation is exclusively StickyHeader's own back arrow, which
    // goes through AppController methods that know what "back" means for
    // whatever screen is showing (see backToHome, goTrack, etc.).
    return PopScope(
      canPop: false,
      child: Scaffold(
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Stack(
              children: [
                Positioned.fill(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 220),
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
      case Screen.rfidRegister:
        return const RfidRegisterScreen(key: ValueKey('rfidRegister'));
      case Screen.rfidLocate:
        return const RfidLocateScreen(key: ValueKey('rfidLocate'));
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

  @override
  Widget build(BuildContext context) {
    final id = context.select<AppController, int>((c) => c.offlineEventId);
    if (_lastSeen == null) {
      // First build: this is the app's starting state, not a drop that just
      // happened — nothing to alert about yet.
      _lastSeen = id;
    } else if (id != _lastSeen) {
      _lastSeen = id;
      final c = context.read<AppController>();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        showDialog<void>(
          context: context,
          builder: (dialogCtx) => AlertDialog(
            title: const Text('ขาดการเชื่อมต่อกับระบบหลัก'),
            content: Text(
              c.connError ?? 'ระบบจะลองเชื่อมต่อใหม่อัตโนมัติ — ข้อมูลที่ยิงระหว่างนี้จะถูกพักคิวไว้',
            ),
            actions: [
              TextButton(onPressed: () => Navigator.of(dialogCtx).pop(), child: const Text('รับทราบ')),
              FilledButton(
                onPressed: () {
                  Navigator.of(dialogCtx).pop();
                  c.goDeviceSetup();
                },
                child: const Text('ตั้งค่าระบบ'),
              ),
            ],
          ),
        );
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
