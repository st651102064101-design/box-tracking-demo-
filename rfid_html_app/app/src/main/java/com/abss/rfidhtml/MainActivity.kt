package com.abss.rfidhtml

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

/**
 * The whole app: one full-screen WebView showing `rfid_test/index.html` (bundled
 * as an asset), with the Zebra RFID SDK wired into it.
 *
 * This exists because a page loaded in Chrome — however it is served — has no
 * route to the RFIDAPI3 SDK at all. There is no permission to grant: the SDK is
 * a Java library talking to an on-device service, not a web-exposed capability.
 * DataWedge keystroke output is the only thing a plain browser can consume, and
 * it goes through the IME, which is where the per-read delay comes from. Hosting
 * the same HTML here bypasses the keyboard entirely — tag reads land in JS
 * straight off the SDK's callback thread.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private var bridge: RfidBridge? = null

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this)
        setContentView(web)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // A tap-to-play gesture requirement would mute the WebAudio beep until
        // the operator remembered to tap the screen once.
        web.settings.mediaPlaybackRequiresUserGesture = false
        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect over USB

        val rfid = RfidBridge(applicationContext, web)
        bridge = rfid
        // The page calls AndroidRfid.connect()/start()/stop(); its presence is
        // also how index.html detects it is running natively rather than in a
        // browser under DataWedge.
        web.addJavascriptInterface(rfid, "AndroidRfid")

        web.loadUrl("file:///android_asset/index.html")
    }

    override fun onDestroy() {
        bridge?.dispose()
        bridge = null
        web.destroy()
        super.onDestroy()
    }
}
