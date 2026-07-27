import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'controllers/app_controller.dart';
import 'services/api_client.dart';
import 'services/i18n.dart';
import 'services/prefs.dart';
import 'services/rfid_service.dart';
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
  // fire-and-forget bootstrap (auth + state fetch), UI shows the boot splash
  controller.init();

  runApp(BoxTraceApp(controller: controller, locale: locale));
}

class BoxTraceApp extends StatelessWidget {
  final AppController controller;
  final LocaleController locale;
  const BoxTraceApp({super.key, required this.controller, required this.locale});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: controller),
        ChangeNotifierProvider.value(value: locale),
      ],
      child: MaterialApp(
        title: 'BoxTrace PDA',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        home: const RootScreen(),
      ),
    );
  }
}
