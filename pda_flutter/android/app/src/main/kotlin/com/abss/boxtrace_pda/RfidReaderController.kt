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
import kotlin.math.abs

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
        private const val BEEP_MIN_GAP_MS = 150L

        /**
         * The transmit power ใกล้ maps to, in 0.1 dBm units (5.0 dBm as the
         * bottom of the range, which puts ใกล้ around 12 dBm).
         *
         * Deliberately low, because too *much* power is what stops a tag held
         * against the reader from being read at all: at full output the
         * reflection off a tag that close saturates the receiver and cannot be
         * demodulated, while a tag half a metre away comes back inside the
         * dynamic range and reads fine. That is the whole of the "the one
         * touching the head doesn't read but the far one does" complaint, and
         * no amount of RSSI sorting fixes it — only turning the power down.
         *
         * The floor is not zero: the picker still has to leave enough output
         * to energise a passive tag. See [setPower].
         */
        private const val MIN_USABLE_DBM_TENTHS = 50

        /** Tags asked for per getReadTags() call while draining a batch. */
        private const val TAGS_PER_READ = 100

        /** Hard stop on one drain, so a reader sitting in a dense tag field
         *  can never hold the SDK callback thread indefinitely. */
        private const val MAX_TAGS_PER_DRAIN = 1000
    }

    private val main = Handler(Looper.getMainLooper())
    // One short beep per read batch — not per tag, or a multi-tag inventory
    // burst turns into a machine-gun of overlapping tones. Rate-limited on top
    // of that: while the trigger is held a batch can arrive several times a
    // second, and queueing a 120 ms tone for each one both sounds like a buzz
    // and keeps the audio path busy for longer than the gap between batches.
    private val toneGen by lazy { ToneGenerator(AudioManager.STREAM_NOTIFICATION, 90) }
    @Volatile private var lastBeepAt = 0L
    private fun beep() {
        val now = System.currentTimeMillis()
        if (now - lastBeepAt < BEEP_MIN_GAP_MS) return
        lastBeepAt = now
        // Never on the SDK's callback thread — that thread's only job is to
        // drain tag reads, and ToneGenerator can stall on a busy audio path.
        main.post {
            try {
                toneGen.startTone(ToneGenerator.TONE_PROP_BEEP, 60)
            } catch (e: Exception) {
                Log.w(TAG, "beep failed", e)
            }
        }
    }

    // Control commands (connect/start/stop/power) get their own thread, kept
    // deliberately free of anything slow. Access operations (the explicit TID
    // read) run on a second one: `readWait` blocks for hundreds of ms, and
    // when both shared a single executor a trigger pull queued behind an
    // in-flight TID read — which is exactly what made the gun feel unresponsive.
    private val exec = Executors.newSingleThreadExecutor()
    private val accessExec = Executors.newSingleThreadExecutor()

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

    /**
     * Diagnostic mode: report every tag field and chase a missing TID with an
     * explicit access read. Off by default; only the RFID tag-reader screen,
     * whose whole job is showing what the SDK returns, turns it on.
     *
     * Off is what makes rapid reading possible. [readTidExplicit] must stop
     * the inventory to run an access operation, so with it always-on, aiming
     * at a single box — the normal case, and precisely when `tags.size == 1`
     * matched — tore the inventory down and rebuilt it on *every* batch. The
     * scan, track and login screens never look at a TID or at PC/CRC/phase,
     * so they were paying both costs for nothing.
     */
    @Volatile private var detailed = false

    /**
     * Reads weaker than this (dBm, e.g. -55) are dropped before they ever
     * reach Flutter. Null disables the filter.
     *
     * At full transmit power this reader happily inventories tags metres away
     * and through boxes, so "hold the gun against the tag you mean" is not by
     * itself enough to pick that tag — the room answers too. Registration
     * pairs a low power setting with a strict floor here so only a tag within
     * a few centimetres can win.
     */
    @Volatile private var rssiThreshold: Int? = null

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
            "setDetailed" -> { setDetailed(call.argument<Boolean>("enabled") == true); result.success(true) }
            "setRssiThreshold" -> { rssiThreshold = call.argument<Int>("dbm"); result.success(true) }
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
        m["detailed"] = detailed
        m["rssiThreshold"] = rssiThreshold

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

    // ── connect / configure ───────────────────────────────────────────────
    fun connect() {
        if (isConnected()) {
            status("connected", "เชื่อมต่อแล้ว")
            return
        }
        status("connecting", "กำลังค้นหาเครื่องอ่าน…")
        exec.execute {
            try {
                patchApi3UtilsContext()
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

    /**
     * Works around a bug in rfidapi3lib itself (confirmed by decompiling
     * API3_TRANSPORT-release-2.0.4.177.aar): on Android ≤ 9,
     * `TransportSerial` asks `API3Utils.isDeviceRFID()` whether this device
     * has an integrated reader, and that method reads a *package-private*
     * static field `API3Utils.m_scontext` — which nothing in the SDK ever
     * sets. `Readers`'s constructor sets `Readers.m_scontext` instead: two
     * same-named-but-distinct static fields on two different classes, and
     * only one of them is wired up. The result is a null Context and an NPE
     * on every connect attempt on this MC3390R's Android 8.1, with no public
     * API to fix it — `API3Utils` isn't even a public class, so this can
     * only be reached with reflection, not a normal Zebra API call. This
     * device can't take an OS update, so this is the only way to keep the
     * integrated reader working: mirror the same context onto both fields.
     * Safe to call every connect attempt; falls through quietly if some
     * future SDK release removes/renames the field, since RFID would then
     * be broken for a different reason anyway.
     */
    private fun patchApi3UtilsContext() {
        try {
            val cls = Class.forName("com.zebra.rfid.api3.API3Utils")
            val field = cls.getDeclaredField("m_scontext")
            field.isAccessible = true
            field.set(null, context.applicationContext)
        } catch (e: Exception) {
            Log.w(TAG, "patchApi3UtilsContext: reflection failed, leaving as-is (${e.message})")
        }
    }

    /**
     * On some units the on-device RFID service is a different version than
     * the client SDK bundled in this app, and enumerating one transport
     * throws instead of just returning empty — seen on this fleet as
     * SERVICE_SERIAL raising a raw `RuntimeException` ("Error while
     * instantiating Transport class") wrapping an internal NPE, not the
     * `InvalidUsageException` the SDK docs lead you to expect. Swallowing
     * only that one exception type let a SERVICE_SERIAL failure abort the
     * whole connect() instead of falling through to try Bluetooth/USB next,
     * which defeated the fallback chain in [connect] entirely. Catch broadly
     * here — any enumeration failure just means "nothing on this transport,
     * try the next one."
     */
    private fun safeList(): ArrayList<ReaderDevice> =
        try {
            readers?.GetAvailableRFIDReaderList() ?: ArrayList()
        } catch (e: Exception) {
            Log.w(TAG, "reader enumeration failed for this transport", e)
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
            // FALSE, and this is the single most important line for read rate.
            //
            // With it true the SDK fires one event carrying one fully-populated
            // TagData per tag, so a dense sweep becomes thousands of individual
            // callbacks and the reader cannot get anywhere near its rated rate.
            // With it false the event is only a "tags are waiting" nudge and we
            // drain them in bulk with getReadTags() — the pattern Zebra's own
            // 123RFID Mobile uses, and the reason it streams hundreds of tags a
            // second where this app managed a trickle.
            rd.Events.setAttachTagDataWithReadEvent(false)
            rd.Events.setReaderDisconnectEvent(true)

            val trigger = TriggerInfo()
            trigger.StartTrigger.setTriggerType(START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE)
            trigger.StopTrigger.setTriggerType(STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE)
            rd.Config.setStartTrigger(trigger.StartTrigger)
            rd.Config.setStopTrigger(trigger.StopTrigger)

            // power: index-based, take the maximum supported
            val powerTable = rd.ReaderCapabilities.getTransmitPowerLevelValues()
            maxPower = powerTable.size - 1
            // Logged because the ใกล้/ปานกลาง/ไกล mapping is only meaningful
            // relative to this table, and it differs between reader models —
            // without it, diagnosing "that setting reads nothing" is guesswork.
            Log.i(
                TAG,
                "power table: ${powerTable.size} steps, " +
                    "${powerTable.min() / 10.0}..${powerTable.max() / 10.0} dBm",
            )
            val cfg = rd.Config.Antennas.getAntennaRfConfig(1)
            cfg.setTransmitPowerIndex(maxPower)
            cfg.setrfModeTableIndex(0)
            cfg.setTari(0)
            rd.Config.Antennas.setAntennaRfConfig(1, cfg)

            // DPO (Dynamic Power Optimization) OFF, deliberately. It was briefly
            // switched on to try to make near tags win over far ones, but that
            // is not what it does: DPO is a *battery* feature that quietly
            // cycles transmit power down between inventory rounds, which shows
            // up to an operator as the gun reading in bursts with dead gaps
            // instead of continuously. Zebra also requires it off while access
            // operations (our TID reads) run. Near-vs-far is handled properly
            // by transmit power plus [rssiThreshold] instead.
            try {
                rd.Config.setDPOState(DYNAMIC_POWER_OPTIMIZATION.DISABLE)
            } catch (e: Exception) {
                Log.w(TAG, "disabling DPO failed", e)
            }

            // singulation S0 / state A — read tags continuously while triggered
            val s = rd.Config.Antennas.getSingulationControl(1)
            s.setSession(SESSION.SESSION_S0)
            s.Action.setInventoryState(INVENTORY_STATE.INVENTORY_STATE_A)
            s.Action.setSLFlag(SL_FLAG.SL_ALL)
            rd.Config.Antennas.setSingulationControl(1, s)

            rd.Actions.PreFilters.deleteAll()

            applyTagFields(rd)
        } catch (e: Exception) {
            Log.e(TAG, "configure failed", e)
        }
    }

    /**
     * Chooses how much the reader reports per tag.
     *
     * Every extra field is extra air time and extra bytes per tag, so the fast
     * path asks for as little as it can get away with. [detailed] mode — the
     * RFID tag-reader screen, which exists to show what the SDK actually
     * returns — asks for everything and accepts the lower rate that comes with
     * it. Scanning and tracking never display these fields, so they would be
     * paying for them for nothing.
     *
     * (Passing a field array *replaces* the reported set rather than adding to
     * it, which is how an earlier `arrayOf(TAG_FIELD.TID)` silently switched
     * off the PC/CRC/antenna/channel fields the viewer shows.)
     */
    private fun applyTagFields(rd: RFIDReader) {
        try {
            val storage = rd.Config.getTagStorageSettings()
            // The EPC is the tag id itself and always comes back — there is no
            // TAG_FIELD for it — so the lean set is just the one extra field
            // the fast path actually uses to tell near tags from far ones.
            storage.setTagFields(
                if (detailed) arrayOf(TAG_FIELD.ALL_TAG_FIELDS)
                else arrayOf(TAG_FIELD.PEAK_RSSI),
            )
            rd.Config.setTagStorageSettings(storage)
        } catch (e: Exception) {
            Log.w(TAG, "setting tag-field reporting failed — reads may carry EPC only", e)
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

    /**
     * Sets antenna power from the ใกล้/ปานกลาง/ไกล picker's percentage.
     *
     * The percentage is mapped across a *usable dBm range*, not across the raw
     * index range. The reader's power table starts at essentially no output,
     * so the old `index = maxIndex * percent / 100` put "ใกล้" (30%) at around
     * 9 dBm and "ปานกลาง" (65%) at around 19 dBm — far too weak to energise a
     * passive tag at any useful distance, which is why both settings read
     * nothing at all while only "ไกล" (100% = full power) worked.
     *
     * Anchoring the low end at [MIN_USABLE_DBM_TENTHS] instead means every
     * setting transmits enough to actually read; the picker then controls
     * range, which is what it claims to do.
     */
    /** Switches diagnostic reporting on/off — see [detailed]. Re-applies the
     *  tag-field set immediately so it takes effect on the next sweep. */
    private fun setDetailed(enabled: Boolean) {
        detailed = enabled
        exec.execute {
            val rd = reader ?: return@execute
            if (rd.isConnected) applyTagFields(rd)
        }
    }

    fun setPower(percent: Int) {
        exec.execute {
            try {
                val rd = reader ?: return@execute
                val values = rd.ReaderCapabilities.getTransmitPowerLevelValues()
                if (values == null || values.isEmpty()) return@execute
                // Power table units are 0.1 dBm. Don't assume it's sorted.
                val maxVal = values.max()
                val minVal = values.min()
                val floor = MIN_USABLE_DBM_TENTHS.coerceIn(minVal, maxVal)
                val pct = percent.coerceIn(0, 100)
                val target = floor + (maxVal - floor) * pct / 100
                // Nearest supported step to the target, since the table is
                // coarse and rarely contains the exact value asked for.
                var idx = 0
                var bestDiff = Int.MAX_VALUE
                for (i in values.indices) {
                    val d = abs(values[i] - target)
                    if (d < bestDiff) { bestDiff = d; idx = i }
                }
                val cfg = rd.Config.Antennas.getAntennaRfConfig(1)
                cfg.setTransmitPowerIndex(idx)
                rd.Config.Antennas.setAntennaRfConfig(1, cfg)
                Log.i(TAG, "setPower $pct% -> ${values[idx] / 10.0} dBm (index $idx of ${values.size - 1})")
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
            exec.shutdown()
            accessExec.shutdown()
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
     * Only ever reached when a screen has asked for TIDs via [detailed] —
     * see the call site for why running it unconditionally made the trigger
     * feel broken.
     *
     * Two hard constraints, both learned the painful way, both the reason
     * this is scheduled onto [accessExec] rather than called inline:
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
            // Drain everything the reader has buffered, not just one helping.
            // The event says "tags are waiting", not "here is a tag" (see
            // setAttachTagDataWithReadEvent in configureReader), and a dense
            // sweep can queue far more than one getReadTags() returns; stopping
            // after the first call left the rest to go stale.
            val drained = ArrayList<TagData>()
            while (drained.size < MAX_TAGS_PER_DRAIN) {
                val chunk = rd.Actions.getReadTags(TAGS_PER_READ) ?: break
                if (chunk.isEmpty()) break
                drained.addAll(chunk)
                if (chunk.size < TAGS_PER_READ) break
            }
            if (drained.isEmpty()) return
            val all: Array<TagData> = drained.toTypedArray()
            // Drop everything below the caller's RSSI floor before anything
            // else looks at it, so a distant tag can't win a race it should
            // never have been entered into. Reads with no RSSI at all are
            // kept — better a tag with unknown strength than a dropped one.
            val floor = rssiThreshold
            val tags = if (floor == null) all else all.filter { t ->
                (num { t.getPeakRSSI().toInt() } ?: Int.MAX_VALUE) >= floor
            }.toTypedArray()
            if (tags.isEmpty()) return
            beep()
            // Strongest (nearest) first, so a consumer that takes the first
            // read of a batch takes the tag the operator is aiming at.
            val sortedTags = tags.sortedByDescending { num { it.getPeakRSSI().toInt() } ?: Int.MIN_VALUE }
            val batch = ArrayList<Map<String, Any?>>(sortedTags.size)
            for (t in sortedTags) {
                tagCount++
                val epc = t.getTagID()
                val rssi = num { t.getPeakRSSI().toInt() }
                lastEpc = epc
                lastRssi = rssi
                // Whatever the inventory round happened to carry. Empty here
                // does NOT mean the tag lacks a TID — see readTidExplicit for
                // the fallback and why it can't run inline on this thread.
                val inventoryTid = str { t.getTID() }?.takeIf { it.isNotEmpty() }
                val payload = mutableMapOf<String, Any?>(
                    "epc" to epc,
                    "tid" to inventoryTid,
                    "rssi" to rssi,
                )
                // The rest is only populated in detailed mode anyway (see
                // applyTagFields), and reading absent fields per tag costs real
                // time at a hundred tags a second.
                if (detailed) {
                    payload["pc"] = num { t.getPC() }
                    payload["crc"] = str { t.getStringCRC() }
                    payload["antenna"] = num { t.getAntennaID().toInt() }
                    payload["channel"] = str { t.getChannel() }
                    payload["phase"] = num { t.getPhase().toInt() }
                    payload["seenCount"] = num { t.getTagSeenCount() }
                }
                if (detailed && inventoryTid == null && !epc.isNullOrEmpty() && tags.size == 1) {
                    // One tag in front of the antenna on the screen that exists
                    // to show TIDs — go get it properly on the access thread and
                    // emit separately once it lands. Never on the fast path:
                    // this stops the inventory to run an access operation.
                    accessExec.execute {
                        payload["tid"] = readTidExplicit(epc)
                        emit(mapOf("type" to "tags", "tags" to listOf(payload)))
                    }
                } else {
                    batch.add(payload)
                }
            }
            // One channel message for the whole batch. Posting each tag
            // separately meant a main-thread hop per tag, which is its own
            // ceiling well below the rate the reader can actually deliver.
            if (batch.isNotEmpty()) emit(mapOf("type" to "tags", "tags" to batch))
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
