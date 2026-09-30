import 'package:flutter_test/flutter_test.dart';

import 'package:smarttrace_pda/services/realtime_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('waiting for a token does not report the stream as offline', () async {
    var downs = 0;
    final rt = RealtimeService();
    rt.connect(
      baseUrl: () => 'http://127.0.0.1',
      token: () => null,
      onStateChanged: () {},
      onConnectivity: (up) {
        if (!up) downs++;
      },
    );
    await Future<void>.delayed(Duration.zero);
    expect(downs, 0);
    rt.dispose();
  });
}
