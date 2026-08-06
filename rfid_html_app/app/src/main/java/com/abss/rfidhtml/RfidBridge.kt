package com.abss.rfidhtml

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.zebra.rfid.api3.*
import java.util.concurrent.Executors

/**
 * Zebra RFIDAPI3 → WebView bridge, cut down to exactly what a "one input,
 * fire as fast as the reader can read" test page needs.
 *
 * Deliberately *not* carried over from the fuller controller in pda_flutter:
 *
 *  - No explicit TID read-back. That path has to `Inventory.stop()` to run an
 *    access operation and start it again afterwards, which puts a hole of tens
 *    of milliseconds between reads — the exact delay this page exists to rule
 *    out.
 *  - No per-tag beep on the SDK's callback thread. `ToneGenerator.startTone`
 *    from inside `eventReadNotify` serialises against the next read event; the
 *    page beeps in WebAudio instead, off the read path.
 *
 * Tag reads are handed to JS a whole read-event at a time (`window.__rfid.push`
 * takes an array), so one burst of 50 tags costs one `evaluateJavascript` hop
 * rather than 50.
 */
class RfidBridge(private val context: Context, private val web: WebView) {

    companion object { private const val TAG = "RfidHtml" }

    private val main = Handler(Looper.getMainLooper())
    private val exec = Executors.newSingleThreadExecutor()

    private var readers: Readers? = null
    private var reader: RFIDReader? = null
    private var events: EventHandler? = null

    // ── JS → native ───────────────────────────────────────────────────────
    @JavascriptInterface
    fun connect() = connectInternal()

    @JavascriptInterface
    fun start() = exec.execute {
        try { reader?.Actions?.Inventory?.perform() }
        catch (e: Exception) { Log.w(TAG, "start failed", e) }
    }

    @JavascriptInterface
    fun stop() = exec.execute {
        try { reader?.Actions?.Inventory?.stop() }
        catch (e: Exception) { Log.w(TAG, "stop failed", e) }
    }

    // ── native → JS ───────────────────────────────────────────────────────
    private fun status(state: String, message: String) {
        main.post {
            web.evaluateJavascript(
                "window.__rfid && window.__rfid.status(${quote(state)},${quote(message)})", null
            )
        }
    }

    private fun pushTags(json: String) {
        main.post { web.evaluateJavascript("window.__rfid && window.__rfid.push($json)", null) }
    }

    /** Minimal JSON string escaping — EPCs are hex, but status text is free-form Thai. */
    private fun quote(s: String): String {
        val sb = StringBuilder(s.length + 2).append('"')
        for (c in s) when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            else -> if (c < ' ') sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
        }
        return sb.append('"').toString()
    }

    // ── connect / configure ───────────────────────────────────────────────
    private fun connectInternal() {
        if (reader?.isConnected == true) { status("connected", "เชื่อมต่อแล้ว"); return }
        status("connecting", "กำลังค้นหาเครื่องอ่าน…")
        exec.execute {
            try {
                patchApi3UtilsContext()
                if (readers == null) readers = Readers(context, ENUM_TRANSPORT.SERVICE_SERIAL)

                var list = safeList()
                if (list.isEmpty()) { readers?.setTransport(ENUM_TRANSPORT.BLUETOOTH); list = safeList() }
                if (list.isEmpty()) { readers?.setTransport(ENUM_TRANSPORT.SERVICE_USB); list = safeList() }
                if (list.isEmpty()) { status("error", "ไม่พบเครื่องอ่าน RFID"); return@execute }

                val rd = list[0].getRFIDReader()
                reader = rd
                try {
                    rd.connect()
                } catch (e: OperationFailureException) {
                    if (e.getResults() == RFIDResults.RFID_READER_REGION_NOT_CONFIGURED) {
                        configureRegion(rd); rd.connect()
                    } else throw e
                }

                if (rd.isConnected) {
                    configureReader(rd)
                    status("connected", "SDK: ${rd.getHostName()}")
                } else {
                    status("error", "เชื่อมต่อไม่สำเร็จ")
                }
            } catch (e: Exception) {
                val detail = if (e is OperationFailureException) " (${e.getResults()})" else ""
                Log.e(TAG, "connect failed$detail", e)
                status("error", (e.message ?: "เชื่อมต่อไม่สำเร็จ") + detail)
            }
        }
    }

    /**
     * Works around a bug inside rfidapi3lib: on Android ≤ 9 `TransportSerial`
     * asks the package-private `API3Utils.m_scontext` for a Context, but only
     * `Readers.m_scontext` — a different static field on a different class — is
     * ever assigned. The result is an NPE on every connect on this MC3390R's
     * Android 8.1, reachable only by reflection since `API3Utils` isn't public.
     * Same fix as pda_flutter's RfidReaderController; see its comment for the
     * full story.
     */
    private fun patchApi3UtilsContext() {
        try {
            val f = Class.forName("com.zebra.rfid.api3.API3Utils").getDeclaredField("m_scontext")
            f.isAccessible = true
            f.set(null, context.applicationContext)
        } catch (e: Exception) {
            Log.w(TAG, "patchApi3UtilsContext: reflection failed (${e.message})")
        }
    }

    /**
     * Enumerating a transport can throw rather than return empty when the
     * on-device RFID service and the bundled client SDK are different versions
     * — seen as a raw RuntimeException from SERVICE_SERIAL, not the
     * InvalidUsageException the docs suggest. Catch broadly: any failure here
     * just means "nothing on this transport, try the next".
     */
    private fun safeList(): ArrayList<ReaderDevice> =
        try { readers?.GetAvailableRFIDReaderList() ?: ArrayList() }
        catch (e: Exception) { Log.w(TAG, "enumeration failed for this transport", e); ArrayList() }

    private fun configureRegion(rd: RFIDReader) {
        try {
            val cfg = rd.Config.getRegulatoryConfig() ?: return
            val region = rd.ReaderCapabilities.SupportedRegions.getRegionInfo(0)
            cfg.setRegion(region.getRegionCode())
            cfg.setIsHoppingOn(region.isHoppingConfigurable())
            cfg.setEnabledChannels(region.getSupportedChannels())
            cfg.setStandardName(region.getName())
            rd.Config.setRegulatoryConfig(cfg)
        } catch (e: Exception) {
            Log.w(TAG, "region config failed", e)
        }
    }

    private fun configureReader(rd: RFIDReader) {
        try {
            if (events == null) events = EventHandler()
            rd.Events.addEventsListener(events)
            rd.Events.setHandheldEvent(true)
            rd.Events.setTagReadEvent(true)
            rd.Events.setAttachTagDataWithReadEvent(false) // EPC + RSSI is all the page shows
            rd.Events.setReaderDisconnectEvent(true)

            val trigger = TriggerInfo()
            trigger.StartTrigger.setTriggerType(START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE)
            trigger.StopTrigger.setTriggerType(STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE)
            rd.Config.setStartTrigger(trigger.StartTrigger)
            rd.Config.setStopTrigger(trigger.StopTrigger)

            val maxPower = rd.ReaderCapabilities.getTransmitPowerLevelValues().size - 1
            val ant = rd.Config.Antennas.getAntennaRfConfig(1)
            ant.setTransmitPowerIndex(maxPower)
            ant.setrfModeTableIndex(0)
            ant.setTari(0)
            rd.Config.Antennas.setAntennaRfConfig(1, ant)

            // Session S0 / state A: a tag stays reportable for as long as it is
            // in the field, so holding the trigger on one tag keeps producing
            // reads instead of falling silent after the first — that repeat
            // stream is what "ยิงรัวต่อเนื่อง" means here.
            val s = rd.Config.Antennas.getSingulationControl(1)
            s.setSession(SESSION.SESSION_S0)
            s.Action.setInventoryState(INVENTORY_STATE.INVENTORY_STATE_A)
            s.Action.setSLFlag(SL_FLAG.SL_ALL)
            rd.Config.Antennas.setSingulationControl(1, s)

            rd.Actions.PreFilters.deleteAll()
        } catch (e: Exception) {
            Log.e(TAG, "configure failed", e)
        }
    }

    fun dispose() {
        try {
            reader?.let { rd ->
                events?.let { rd.Events.removeEventsListener(it) }
                if (rd.isConnected) rd.disconnect()
            }
            reader = null
            readers?.Dispose()
            readers = null
        } catch (e: Exception) {
            Log.w(TAG, "dispose failed", e)
        }
    }

    // ── SDK callbacks ─────────────────────────────────────────────────────
    private inner class EventHandler : RfidEventsListener {
        override fun eventReadNotify(e: RfidReadEvents?) {
            val rd = reader ?: return
            val tags = rd.Actions.getReadTags(100) ?: return
            if (tags.isEmpty()) return
            val sb = StringBuilder("[")
            for ((i, t) in tags.withIndex()) {
                if (i > 0) sb.append(',')
                sb.append("{\"epc\":").append(quote(t.getTagID() ?: ""))
                  .append(",\"rssi\":").append(t.getPeakRSSI().toInt()).append('}')
            }
            pushTags(sb.append(']').toString())
        }

        override fun eventStatusNotify(e: RfidStatusEvents?) {
            val data = e?.StatusEventData ?: return
            when (data.getStatusEventType()) {
                STATUS_EVENT_TYPE.HANDHELD_TRIGGER_EVENT ->
                    when (data.HandheldTriggerEventData.getHandheldEvent()) {
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_PRESSED -> start()
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED -> stop()
                        else -> {}
                    }
                STATUS_EVENT_TYPE.DISCONNECTION_EVENT -> status("error", "เครื่องอ่านหลุดการเชื่อมต่อ")
                else -> {}
            }
        }
    }
}
