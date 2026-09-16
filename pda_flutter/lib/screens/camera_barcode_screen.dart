import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../theme.dart';

/// Full-screen camera barcode/QR capture for devices without a supported
/// Zebra DataWedge / RFID SDK. Pops with the first decoded value, or null
/// if the operator cancels.
class CameraBarcodeScreen extends StatefulWidget {
  final String title;
  final String hint;

  const CameraBarcodeScreen({
    super.key,
    this.title = 'สแกนด้วยกล้อง',
    this.hint = 'จัดโค้ดให้อยู่ในกรอบ',
  });

  /// Opens the camera scanner and returns the decoded string, or null.
  static Future<String?> open(
    BuildContext context, {
    String title = 'สแกนด้วยกล้อง',
    String hint = 'จัดโค้ดให้อยู่ในกรอบ',
  }) {
    return Navigator.of(context).push<String>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => CameraBarcodeScreen(title: title, hint: hint),
      ),
    );
  }

  @override
  State<CameraBarcodeScreen> createState() => _CameraBarcodeScreenState();
}

class _CameraBarcodeScreenState extends State<CameraBarcodeScreen> {
  final _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.normal,
    facing: CameraFacing.back,
    torchEnabled: false,
  );
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue?.trim();
      if (raw == null || raw.length < 2) continue;
      _handled = true;
      Navigator.of(context).pop(raw);
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(widget.title),
        actions: [
          IconButton(
            tooltip: 'ไฟฉาย',
            onPressed: () => _controller.toggleTorch(),
            icon: const Icon(Icons.flash_on),
          ),
        ],
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
              color: Colors.black54,
              child: Text(
                widget.hint,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 14.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          IgnorePointer(
            child: Center(
              child: Container(
                width: 240,
                height: 240,
                decoration: BoxDecoration(
                  border: Border.all(color: C.lime, width: 2.5),
                  borderRadius: BorderRadius.circular(18),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
