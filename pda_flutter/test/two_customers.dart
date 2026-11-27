import 'app_controller_test.dart' show FakeApi, fixtureState;

/// The shared fixture with a second customer, so order and choice can show.
FakeApi twoCustomers() {
  final api = FakeApi();
  final state = fixtureState();
  (state['customers'] as Map)['CUST-LAST'] = {
    'id': 'CUST-LAST',
    'name': 'ลูกค้าท้ายแถว',
  };
  return api..state = state;
}
