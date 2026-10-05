import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smarttrace_pda/widgets/common.dart';

void main() {
  for (final scale in [1.0, 1.5]) {
    testWidgets('vehicle dropdown paints one placeholder at text scale $scale', (tester) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: BlurDropdownButtonFormField<String>(
          initialValue: null,
          decoration: pdaInput('— เลือกประเภทรถ —'),
          hint: const Text('— เลือกประเภทรถ —'),
          items: const [DropdownMenuItem(value: 'truck', child: Text('รถบรรทุก'))],
          onChanged: (_) {},
        ),
      ))));
      expect(find.text('— เลือกประเภทรถ —'), findsOneWidget);
      expect(tester.widget<InputDecorator>(find.byType(InputDecorator)).decoration.hintText, '');
      expect(tester.takeException(), isNull);
    });
  }
  testWidgets('selected vehicle replaces placeholder without decorator text', (tester) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: BlurDropdownButtonFormField<String>(
      initialValue: 'truck',
      decoration: pdaInput('— เลือกประเภทรถ —'),
      hint: const Text('— เลือกประเภทรถ —'),
      items: const [DropdownMenuItem(value: 'truck', child: Text('รถบรรทุก'))],
      onChanged: (_) {},
    ))));
    expect(find.text('รถบรรทุก'), findsOneWidget);
    expect(find.text('— เลือกประเภทรถ —'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
