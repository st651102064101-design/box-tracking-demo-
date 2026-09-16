import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('cycle count setup shows warehouse context and explicit start', () {
    final src = File('lib/screens/cycle_count_screen.dart').readAsStringSync();
    expect(src.contains('คุณกำลังตรวจนับที่'), isTrue);
    expect(src.contains('เลือกขอบเขตที่จะตรวจนับ'), isTrue);
    expect(src.contains("loc.t('ทั้งคลัง')"), isTrue);
    expect(src.contains("loc.t('เริ่มตรวจนับ')"), isTrue);
    expect(src.contains('_warehouseContextCard'), isTrue);
    expect(src.contains('_scopeTile'), isTrue);
    // Must not auto-start whole-warehouse without an explicit pick.
    expect(src.contains('_autoStartTried'), isFalse);
  });
}
