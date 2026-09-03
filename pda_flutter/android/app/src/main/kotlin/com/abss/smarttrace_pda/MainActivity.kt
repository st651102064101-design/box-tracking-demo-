package com.abss.smarttrace_pda

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Wires the Zebra RFID reader bridge into the Flutter engine:
 *   - MethodChannel  "smarttrace/rfid"        — commands (connect, startInventory, …)
 *   - EventChannel   "smarttrace/rfid/events" — tag reads, trigger presses, status
 */
class MainActivity : FlutterActivity() {
    private var rfid: RfidReaderController? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        val controller = RfidReaderController(applicationContext)
        rfid = controller
        MethodChannel(messenger, "smarttrace/rfid").setMethodCallHandler(controller)
        EventChannel(messenger, "smarttrace/rfid/events").setStreamHandler(controller)
    }

    /**
     * Backgrounding this Activity (recents/home, screen lock, an incoming
     * call) never used to touch the reader at all — inventory left running
     * kept streaming tag-read events into the Flutter engine's main-thread
     * queue the whole time the app was off-screen, with nothing visible to
     * drain them. Coming back meant working through however much had piled
     * up before the UI could respond to anything, which is what "freezes
     * after a while, especially after pressing the recents button" looks
     * like from the operator's side. AppController.didChangeAppLifecycleState
     * does the same stopInventory() call from the Dart side; this is the
     * native-side backstop for whenever the engine is too busy processing
     * that exact backlog to run a Dart listener promptly — the one case
     * where the Dart-side fix can't fire in time to prevent it.
     */
    override fun onPause() {
        rfid?.stopInventory()
        super.onPause()
    }

    override fun onStop() {
        rfid?.stopInventory()
        super.onStop()
    }

    override fun onDestroy() {
        rfid?.dispose()
        rfid = null
        super.onDestroy()
    }
}
