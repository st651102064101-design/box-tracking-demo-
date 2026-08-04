package com.abss.boxtrace_pda

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.zebra.rfid.api3.*
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

/**
 * Native bridge over the Zebra RFIDAPI3 SDK — a Kotlin distillation of the
 * vendor `RFIDHandler.java` sample, exposing just what the PDA app needs:
 * connect / disconnect, start / stop inventory, set power, plus a stream of tag
 * reads and physical-trigger events.
 *
 * Connection targets the MC3390R integrated reader first (SERVICE_SERIAL), then
 * falls back to a Bluetooth sled or USB, matching the sample's enumeration.
 *
 * Every Zebra getter/setter is called with its explicit Java name so Kotlin's
 * property synthesis never guesses the wrong accessor.
 */
class RfidReaderController(private val context: Context) :
    MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler,
    Readers.RFIDReaderEventHandler {

    companion object {
        private const val TAG = "BoxTraceRFID"
    }

    private val main = Handler(Looper.getMainLooper())
    // One short beep per read batch — not per tag, or a multi-tag inventory
    // burst turns into a machine-gun of overlapping tones.
    private val toneGen by lazy { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90) }
    private fun beep() {
        try {
            toneGen.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
        } catch (e: Exception) {
            Log.w(TAG, "beep failed", e)
        }
    }
    private val exec = Executors.newSingleThreadExecutor()

    private var readers: Readers? = null
    private var reader: RFIDReader? = null
    private var eventHandler: EventHandler? = null
    private var sink: EventChannel.EventSink? = null
    private var maxPower = 270

    // Diagnostics state — kept so the Settings screen can answer "is the reader
    // actually working?" with facts (what connected, over which transport, how
    // many tags it has seen, what the last failure said) instead of a dot.
    private var lastError: String? = null
    private var lastTransport: String? = null
    private var tagCount = 0L
    private var lastEpc: String? = null
    private var lastRssi: Int? = null
    // How often the inventory-time TID piggyback came back empty and the
    // explicit fallback read (readTidExplicit) had to run instead, and how
    // often that fallback actually recovered a TID — see eventReadNotify.
    // Surfaced in diagnostics() so "TID keeps failing" can be told apart from
    // "the piggyback path never works on this reader/firmware" at a glance.
    private var tidFallbackAttempts = 0L
    private var tidFallbackSuccesses = 0L
    // Whether the physical gun trigger is currently held — readTidExplicit
    // has to stop inventory to run an access operation, and uses this to
    // decide whether to start it again afterwards.
    @Volatile private var triggerHeld = false

    // ── EventChannel.StreamHandler ────────────────────────────────────────
    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        sink = events
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    private fun emit(map: Map<String, Any?>) {
        main.post { sink?.success(map) }
    }

    private fun status(state: String, message: String) {
        if (state == "error") lastError = message
        emit(mapOf("type" to "status", "state" to state, "message" to message))
    }

    // ── MethodChannel.MethodCallHandler ───────────────────────────────────
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "connect" -> { connect(); result.success(true) }
            "disconnect" -> { disconnect(); result.success(true) }
            "startInventory" -> { startInventory(); result.success(true) }
            "stopInventory" -> { stopInventory(); result.success(true) }
            "setPower" -> { setPower(call.argument<Int>("percent") ?: 100); result.success(true) }
            "isConnected" -> result.success(isConnected())
            "diagnostics" -> result.success(diagnostics())
            else -> result.notImplemented()
        }
    }

    private fun isConnected(): Boolean = reader?.isConnected == true

    /**
     * One call that answers "is this reader actually working?" — model, firmware,
     * region, transmit power, how many tags have come through and what the last
     * failure said. Without it the only signal on screen is a coloured dot, which
     * is no help at all the first time a terminal is unboxed at a gate.
     *
     * Every field is read defensively: a reader that is connected but only
     * partially responsive should still report what it can rather than throwing
     * the whole panel away.
     */
    private fun diagnostics(): Map<String, Any?> {
        val m = HashMap<String, Any?>()
        m["connected"] = isConnected()
        m["transport"] = lastTransport
        m["tagCount"] = tagCount
        m["lastEpc"] = lastEpc
        m["lastRssi"] = lastRssi
        m["lastError"] = lastError
        m["tidFallbackAttempts"] = tidFallbackAttempts
        m["tidFallbackSuccesses"] = tidFallbackSuccesses

        val rd = reader
        if (rd != null && rd.isConnected) {
            val caps = rd.ReaderCapabilities
            m["host"] = str { rd.getHostName() }
            m["model"] = str { caps.getModelName() }
            m["serial"] = str { caps.getSerialNumber() }
            // Zebra's own spelling — the SDK really does call it "Firware".
            m["firmware"] = str { caps.getFirwareVersion() }
            m["region"] = str { rd.Config.getRegulatoryConfig().getRegion() }
            m["powerMaxIndex"] = maxPower
            m["powerIndex"] = num { rd.Config.Antennas.getAntennaRfConfig(1).getTransmitPowerIndex() }
            m["powerRaw"] = num {
                val values = caps.getTransmitPowerLevelValues()
                val idx = rd.Config.Antennas.getAntennaRfConfig(1).getTransmitPowerIndex()
                values[idx]
            }
        }
        return m
    }

    private inline fun str(f: () -> Any?): String? = try { f()?.toString() } catch (e: Exception) { null }
    private inline fun num(f: () -> Int): Int? = try { f() } catch (e: Exception) { null }

    /**
     * RFIDAPI3 2.0.3.162's `TransportSerial` no-arg constructor calls the
     * package-private `API3Utils.isDeviceRFID()`, which on API ≤ 28 reads a
     * static `m_scontext` field that nothing in the SDK ever assigns — every
     * `Readers`/`IReaders` constructor sets its *own* static context, never
     * this one. The resulting NPE isn't caught (the SDK only catches
     * `InvalidUsageException` there), so it aborts the whole connect. Prime
     * the field by reflection before touching `Readers` so that check
     * actually runs instead of crashing. Safe to call repeatedly; no-op if
     * the field ever disappears in a future SDK build.
     */
    private fun primeApi3UtilsContext() {
        try {
            val cls = Class.forName("com.zebra.rfid.api3.API3Utils")
            val field = cls.getDeclaredField("m_scontext")
            field.isAccessible = true
            field.set(null, context)
        } catch (e: Exception) {
            Log.w(TAG, "could not prime API3Utils context (SDK internals changed?)", e)
        }
    }

    // ── connect / configure ───────────────────────────────────────────────
    fun connect() {
        if (isConnected()) {
            status("connected", "เชื่อมต่อแล้ว")
            return
        }
        status("connecting", "กำลังค้นหาเครื่องอ่าน…")
        exec.execute {
            try {
                primeApi3UtilsContext()
                if (readers == null) readers = Readers(context, ENUM_TRANSPORT.SERVICE_SERIAL)
                // attach/deattach are static on Readers, not instance methods
                Readers.attach(this)

                var list = safeList()
                lastTransport = "SERVICE_SERIAL"
                // MC3390R = SERVICE_SERIAL; fall back to sled / USB like the sample.
                if (list.isEmpty()) {
                    readers?.setTransport(ENUM_TRANSPORT.BLUETOOTH); list = safeList(); lastTransport = "BLUETOOTH"
                }
                if (list.isEmpty()) {
                    readers?.setTransport(ENUM_TRANSPORT.SERVICE_USB); list = safeList(); lastTransport = "SERVICE_USB"
                }
                if (list.isEmpty()) {
                    lastTransport = null
                    status("error", "ไม่พบเครื่องอ่าน RFID")
                    return@execute
                }

                val rd = list[0].getRFIDReader()
                reader = rd

                try {
                    rd.connect()
                } catch (e: OperationFailureException) {
                    if (e.getResults() == RFIDResults.RFID_READER_REGION_NOT_CONFIGURED) {
                        configureRegion(rd)
                        rd.connect()
                    } else {
                        throw e
                    }
                }

                if (rd.isConnected) {
                    configureReader(rd)
                    lastError = null
                    status("connected", "เชื่อมต่อ ${rd.getHostName()}")
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

    private fun safeList(): ArrayList<ReaderDevice> =
        try {
            readers?.GetAvailableRFIDReaderList() ?: ArrayList()
        } catch (e: InvalidUsageException) {
            ArrayList()
        }

    private fun configureRegion(rd: RFIDReader) {
        try {
            val regCfg = rd.Config.getRegulatoryConfig() ?: return
            val region = rd.ReaderCapabilities.SupportedRegions.getRegionInfo(0)
            regCfg.setRegion(region.getRegionCode())
            regCfg.setIsHoppingOn(region.isHoppingConfigurable())
            regCfg.setEnabledChannels(region.getSupportedChannels())
            regCfg.setStandardName(region.getName())
            rd.Config.setRegulatoryConfig(regCfg)
        } catch (e: Exception) {
            Log.w(TAG, "region config failed", e)
        }
    }

    private fun configureReader(rd: RFIDReader) {
        try {
            if (eventHandler == null) eventHandler = EventHandler()
            rd.Events.addEventsListener(eventHandler)
            rd.Events.setHandheldEvent(true)          // physical trigger events
            rd.Events.setTagReadEvent(true)           // tag reads
            rd.Events.setAttachTagDataWithReadEvent(false)
            rd.Events.setReaderDisconnectEvent(true)

            val trigger = TriggerInfo()
            trigger.StartTrigger.setTriggerType(START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE)
            trigger.StopTrigger.setTriggerType(STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE)
            rd.Config.setStartTrigger(trigger.StartTrigger)
            rd.Config.setStopTrigger(trigger.StopTrigger)

            // power: index-based, take the maximum supported
            maxPower = rd.ReaderCapabilities.getTransmitPowerLevelValues().size - 1
            val cfg = rd.Config.Antennas.getAntennaRfConfig(1)
            cfg.setTransmitPowerIndex(maxPower)
            cfg.setrfModeTableIndex(0)
            cfg.setTari(0)
            rd.Config.Antennas.setAntennaRfConfig(1, cfg)

            // singulation S0 / state A — read tags continuously while triggered
            val s = rd.Config.Antennas.getSingulationControl(1)
            s.setSession(SESSION.SESSION_S0)
            s.Action.setInventoryState(INVENTORY_STATE.INVENTORY_STATE_A)
            s.Action.setSLFlag(SL_FLAG.SL_ALL)
            rd.Config.Antennas.setSingulationControl(1, s)

            rd.Actions.PreFilters.deleteAll()

            // Ask the reader to report every field it has for each tag, not
            // just the EPC — TID above all (the factory-burned TID is what
            // makes a tag globally unique; the EPC alone is just whatever we
            // ourselves wrote into it), plus PC/CRC/phase/etc. for the
            // diagnostics screen. This used to pass `arrayOf(TAG_FIELD.TID)`,
            // which *replaces* the reported set rather than adding to it, so
            // it silently turned off the PC/CRC/antenna/channel fields the
            // live viewer shows — hence those reading "—" as well.
            try {
                val storage = rd.Config.getTagStorageSettings()
                storage.setTagFields(arrayOf(TAG_FIELD.ALL_TAG_FIELDS))
                rd.Config.setTagStorageSettings(storage)
            } catch (e: Exception) {
                Log.w(TAG, "enabling full tag-field reporting failed — reads may carry EPC only", e)
            }
        } catch (e: Exception) {
            Log.e(TAG, "configure failed", e)
        }
    }

    fun disconnect() {
        exec.execute {
            try {
                reader?.let { rd ->
                    eventHandler?.let { rd.Events.removeEventsListener(it) }
                    if (rd.isConnected) rd.disconnect()
                }
                status("disconnected", "ตัดการเชื่อมต่อแล้ว")
            } catch (e: Exception) {
                Log.w(TAG, "disconnect failed", e)
            }
        }
    }

    fun startInventory() {
        exec.execute {
            try {
                Log.i(TAG, "startInventory: reader=$reader isConnected=${reader?.isConnected}")
                reader?.Actions?.Inventory?.perform()
            } catch (e: Exception) {
                val detail = if (e is OperationFailureException) " (${e.getResults()})" else ""
                Log.w(TAG, "startInventory failed$detail", e)
            }
        }
    }

    fun stopInventory() {
        exec.execute {
            try {
                reader?.Actions?.Inventory?.stop()
            } catch (e: Exception) {
                Log.w(TAG, "stopInventory failed", e)
            }
        }
    }

    fun setPower(percent: Int) {
        exec.execute {
            try {
                val rd = reader ?: return@execute
                val idx = (maxPower * percent / 100).coerceIn(0, maxPower)
                val cfg = rd.Config.Antennas.getAntennaRfConfig(1)
                cfg.setTransmitPowerIndex(idx)
                rd.Config.Antennas.setAntennaRfConfig(1, cfg)
            } catch (e: Exception) {
                Log.w(TAG, "setPower failed", e)
            }
        }
    }

    fun dispose() {
        try {
            disconnect()
            reader = null
            readers?.Dispose()
            readers = null
            toneGen.release()
        } catch (e: Exception) {
            Log.w(TAG, "dispose failed", e)
        }
    }

    // ── Readers.RFIDReaderEventHandler (device appeared / disappeared) ─────
    override fun RFIDReaderAppeared(device: ReaderDevice) {
        connect()
    }

    override fun RFIDReaderDisappeared(device: ReaderDevice) {
        status("disconnected", "เครื่องอ่านหลุดการเชื่อมต่อ")
    }

    /**
     * Explicit, targeted read of a specific tag's TID memory bank — fallback
     * for when the inventory-time report comes back without one. Nearly every
     * EPC Gen2 tag has a TID baked in at the factory (it's mandatory in the
     * standard), so "this tag has no TID" is rarely the real story behind an
     * empty read; far more often the inventory round simply didn't carry it.
     *
     * Two hard constraints, both learned the painful way, both the reason
     * this is scheduled onto [exec] rather than called inline:
     *
     *  1. It must NOT run on the SDK's event-callback thread. `readWait`
     *     blocks until the access-operation response arrives, and that
     *     response is delivered by `Events$ReadDataAndFireEventThread` — the
     *     very thread `eventReadNotify` runs on. Calling it there blocks the
     *     thread that would unblock it, and every call died with a bare
     *     `OperationFailureException`.
     *  2. An access operation can't run while an inventory is in flight, so
     *     inventory is stopped first and restarted afterwards if the trigger
     *     is still held (see [triggerHeld]) — otherwise a held trigger would
     *     go dead after the first tag.
     */
    private fun readTidExplicit(epc: String): String? {
        val rd = reader ?: return null
        return try {
            tidFallbackAttempts++
            try { rd.Actions.Inventory.stop() } catch (_: Exception) { /* wasn't running */ }
            val tagAccess = rd.Actions.TagAccess
            // ReadAccessParams is a Java inner (non-static) class — Kotlin
            // constructs it off an instance of the enclosing TagAccess, not
            // as a free-standing constructor call.
            val params = tagAccess.ReadAccessParams()
            params.setMemoryBank(MEMORY_BANK.MEMORY_BANK_TID)
            params.setOffset(0)
            params.setCount(6) // words — 96 bits, the mandatory Gen2 TID length
            params.setAccessPassword(0)
            val result = tagAccess.readWait(epc, params, AntennaInfo())
            // A TID-bank read lands in getMemoryBankData() on this SDK;
            // getTID() is only populated when the *inventory* carried it.
            // Take whichever actually came back.
            val tid = str { result?.getTID() }?.takeIf { it.isNotEmpty() }
                ?: str { result?.getMemoryBankData() }?.takeIf { it.isNotEmpty() }
            if (tid != null) tidFallbackSuccesses++
            tid
        } catch (ex: Exception) {
            Log.w(TAG, "explicit TID read failed for $epc", ex)
            null
        } finally {
            // Put the reader back the way the operator left it.
            if (triggerHeld) {
                try { rd.Actions.Inventory.perform() } catch (_: Exception) {}
            }
        }
    }

    // ── SDK read/status callbacks ─────────────────────────────────────────
    inner class EventHandler : RfidEventsListener {
        override fun eventReadNotify(e: RfidReadEvents?) {
            val rd = reader ?: return
            val tags: Array<TagData>? = rd.Actions.getReadTags(100)
            if (tags != null && tags.isNotEmpty()) {
                beep()
                for (t in tags) {
                    tagCount++
                    val epc = t.getTagID()
                    lastEpc = epc
                    lastRssi = t.getPeakRSSI().toInt()
                    // Whatever the inventory round happened to carry. Empty
                    // here does NOT mean the tag lacks a TID — see
                    // readTidExplicit for the fallback and why it can't run
                    // inline on this thread.
                    val inventoryTid = str { t.getTID() }?.takeIf { it.isNotEmpty() }
                    val payload = mutableMapOf<String, Any?>(
                        "type" to "tag",
                        "epc" to epc,
                        "tid" to inventoryTid,
                        "rssi" to t.getPeakRSSI().toInt(),
                        "pc" to num { t.getPC() },
                        "crc" to str { t.getStringCRC() },
                        "antenna" to num { t.getAntennaID().toInt() },
                        "channel" to str { t.getChannel() },
                        "phase" to num { t.getPhase().toInt() },
                        "seenCount" to num { t.getTagSeenCount() },
                    )
                    if (inventoryTid == null && !epc.isNullOrEmpty() && tags.size == 1) {
                        // Single tag in front of the antenna (registration /
                        // live-viewer) and no TID yet — go get it properly on
                        // the worker thread, then emit once with the result,
                        // so the UI sees one complete read instead of a
                        // TID-less one followed by a correction. A bulk
                        // multi-tag sweep skips this: those callers only need
                        // the EPC and shouldn't pay per-tag access latency.
                        exec.execute {
                            payload["tid"] = readTidExplicit(epc)
                            emit(payload)
                        }
                    } else {
                        emit(payload)
                    }
                }
            }
        }

        override fun eventStatusNotify(e: RfidStatusEvents?) {
            val data = e?.StatusEventData ?: return
            when (data.getStatusEventType()) {
                STATUS_EVENT_TYPE.HANDHELD_TRIGGER_EVENT -> {
                    val evt = data.HandheldTriggerEventData.getHandheldEvent()
                    when (evt) {
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_PRESSED -> {
                            triggerHeld = true
                            emit(mapOf("type" to "trigger", "pressed" to true))
                        }
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED -> {
                            triggerHeld = false
                            emit(mapOf("type" to "trigger", "pressed" to false))
                        }
                        else -> {}
                    }
                }
                STATUS_EVENT_TYPE.DISCONNECTION_EVENT -> disconnect()
                else -> {}
            }
        }
    }
}
