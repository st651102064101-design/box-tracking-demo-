import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'controllers/app_controller.dart';
import 'services/api_client.dart';
import 'services/graphics_controller.dart';
import 'services/i18n.dart';
import 'services/prefs.dart';
import 'services/rfid_service.dart';
import 'services/theme_controller.dart';
import 'theme.dart';
import 'screens/root_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);

  final prefs = await Prefs.load();
  final api = ApiClient(baseUrl: prefs.baseUrl, token: prefs.token);
  final rfid = RfidService();
  final controller = AppController(api: api, prefs: prefs, rfid: rfid);
  final locale = LocaleController(prefs);
  final themeCtrl = ThemeController(prefs);
  final graphicsCtrl = GraphicsController(prefs);
  // fire-and-forget bootstrap (auth + state fetch), UI shows the boot splash
  controller.init();

  runApp(BoxTraceApp(controller: controller, locale: locale, themeCtrl: themeCtrl, graphicsCtrl: graphicsCtrl));
}

class BoxTraceApp extends StatelessWidget {
  final AppController controller;
  final LocaleController locale;
  final ThemeController themeCtrl;
  final GraphicsController graphicsCtrl;
  const BoxTraceApp({
    super.key,
    required this.controller,
    required this.locale,
    required this.themeCtrl,
    required this.graphicsCtrl,
  });

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: controller),
        ChangeNotifierProvider.value(value: locale),
        ChangeNotifierProvider.value(value: themeCtrl),
        ChangeNotifierProvider.value(value: graphicsCtrl),
      ],
      child: Builder(
        // Needs its own context (below MultiProvider) so watching ThemeController
        // (and now GraphicsController) rebuilds MaterialApp on every toggle —
        // see theme.dart's C.shadow/C.anim, read at each call site's own build.
        builder: (context) {
          context.watch<ThemeController>();
          context.watch<GraphicsController>();
          return MaterialApp(
            title: 'BoxTrace PDA',
            debugShowCheckedModeBanner: false,
            theme: buildTheme(),
            home: const RootScreen(),
          );
        },
      ),
    );
  }
}
