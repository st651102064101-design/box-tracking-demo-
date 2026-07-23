import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../controllers/app_controller.dart';
import '../theme.dart';
import 'boot_screen.dart';
import 'login_screen.dart';
import 'session_setup_screen.dart';
import 'home_screen.dart';
import 'scan_screen.dart';
import 'track_screen.dart';
import 'settings_screen.dart';
import 'toast_overlay.dart';

/// Hosts the current screen inside a phone-width frame (max 560px, like the
/// mockup) and paints the toast overlay above everything.
class RootScreen extends StatelessWidget {
  const RootScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<AppController>();
    return Scaffold(
      backgroundColor: C.bg,
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
            ],
          ),
        ),
      ),
    );
  }

  Widget _body(AppController c) {
    switch (c.screen) {
      case Screen.boot:
        return const BootScreen(key: ValueKey('boot'));
      case Screen.login:
        return const LoginScreen(key: ValueKey('login'));
      case Screen.session:
        return const SessionSetupScreen(key: ValueKey('session'));
      case Screen.home:
        return const HomeScreen(key: ValueKey('home'));
      case Screen.scan:
        return const ScanScreen(key: ValueKey('scan'));
      case Screen.track:
        return const TrackScreen(key: ValueKey('track'));
      case Screen.settings:
        return const SettingsScreen(key: ValueKey('settings'));
    }
  }
}
