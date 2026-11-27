/// A customer set at the gate on the web is picked on the handheld in advance.
import 'package:flutter_test/flutter_test.dart';

import 'app_controller_test.dart' show makeController;
import 'two_customers.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  test('shipping starts with the customer set at this gate', () async {
    final api = twoCustomers();
    final c = await makeController(api);
    final id = c.customerList.last['id'] as String;
    api.gateCustomers[c.gate] = id;

    c.goScanOut();
    await settle();
    expect(c.outCustomer, id);
    expect(c.gateCustomer, id);
    c.dispose();
  });

  test('a choice the operator already made is kept', () async {
    final api = twoCustomers();
    final c = await makeController(api);
    api.gateCustomers[c.gate] = c.customerList.last['id'] as String;
    final mine = c.customerList.first['id'] as String;

    c.goScanOut();
    c.setOutCustomer(mine);
    await settle();
    expect(c.outCustomer, mine);
    c.dispose();
  });

  test('receiving, an unknown customer and a failed lookup change nothing',
      () async {
    final api = twoCustomers();
    final c = await makeController(api);
    api.gateCustomers[c.gate] = c.customerList.last['id'] as String;
    c.goScanIn();
    await settle();
    expect(c.outCustomer, isEmpty);

    api.gateCustomers[c.gate] = 'NOBODY';
    c.goScanOut();
    await settle();
    expect(c.outCustomer, isEmpty);
    expect(c.gateCustomer, isEmpty);
    c.dispose();
  });
}
