import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:smarttrace_pda/services/prefs.dart';

/// Covers the offline PIN fallback added for gate terminals that lose the
/// backend mid-shift (see login_screen.dart's _verifyThenEnter): the server
/// is still the authority whenever it's reachable, but an employee who
/// already has a PIN set has to be able to badge in without it too.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<Prefs> freshPrefs() async {
    SharedPreferences.setMockInitialValues({});
    return Prefs.load();
  }

  test('unset employee has no offline PIN to match', () async {
    final p = await freshPrefs();
    expect(p.verifyPinOffline('emp-1', '1234'), isFalse);
  });

  test('correct PIN verifies offline after being cached', () async {
    final p = await freshPrefs();
    p.cachePinHash('emp-1', '4821');
    expect(p.verifyPinOffline('emp-1', '4821'), isTrue);
  });

  test('wrong PIN does not verify offline', () async {
    final p = await freshPrefs();
    p.cachePinHash('emp-1', '4821');
    expect(p.verifyPinOffline('emp-1', '0000'), isFalse);
  });

  test('one employee\'s cached PIN never matches another employee', () async {
    final p = await freshPrefs();
    p.cachePinHash('emp-1', '4821');
    expect(p.verifyPinOffline('emp-2', '4821'), isFalse);
  });

  test('a fresh cachePinHash call replaces the previous one', () async {
    final p = await freshPrefs();
    p.cachePinHash('emp-1', '4821');
    p.cachePinHash('emp-1', '9999'); // e.g. changed via the web app, seen on next online verify
    expect(p.verifyPinOffline('emp-1', '4821'), isFalse);
    expect(p.verifyPinOffline('emp-1', '9999'), isTrue);
  });

  test('the cached value is a hash, never the PIN in plain text', () async {
    SharedPreferences.setMockInitialValues({});
    final raw = await SharedPreferences.getInstance();
    final p = Prefs(raw);
    p.cachePinHash('emp-1', '4821');
    final stored = raw.getString('smarttrace_pin_hash_emp-1');
    expect(stored, isNotNull);
    expect(stored, isNot(contains('4821')));
  });
}
