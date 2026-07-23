package com.abss.boxtrace_pda

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Wires the Zebra RFID reader bridge into the Flutter engine:
 *   - MethodChannel  "boxtrace/rfid"        — commands (connect, startInventory, …)
 *   - EventChannel   "boxtrace/rfid/events" — tag reads, trigger presses, status
 */
class MainActivity : FlutterActivity() {
    private var rfid: RfidReaderController? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        val controller = RfidReaderController(applicationContext)
        rfid = controller
        MethodChannel(messenger, "boxtrace/rfid").setMethodCallHandler(controller)
        EventChannel(messenger, "boxtrace/rfid/events").setStreamHandler(controller)
    }

    override fun onDestroy() {
        rfid?.dispose()
        rfid = null
        super.onDestroy()
    }
}
