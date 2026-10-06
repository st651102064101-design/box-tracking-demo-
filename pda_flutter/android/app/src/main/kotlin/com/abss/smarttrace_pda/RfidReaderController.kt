package com.abss.smarttrace_pda

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.zebra.rfid.api3.*
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

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
        private const val TAG = "SmartTraceRFID"
    }

    private val main = Handler(Looper.getMainLooper())
    // Dense, continuous feedback while the trigger is held, matching Zebra's own
    // 123RFID Mobile reference app. STREAM_MUSIC (not STREAM_NOTIFICATION) so it
    // isn't silenced by a device's "silent notifications" policy, and a short
    // 40ms tone so back-to-back reads produce distinct ticks rather than one
    // tone cutting the next one off.
    //
    // Runs on its own thread and never from [EventHandler.eventReadNotify]:
    // `startTone` is a binder round-trip into AudioFlinger, and doing it inline
    // serialises tone latency against the SDK's read callback — the thread that
    // would otherwise be draining the next batch of tags. `beepInFlight` drops
    // ticks rather than queueing them, because a reader running at ~180 tags/s
    // can enqueue tones far faster than a 40ms tone can play, and an unbounded
    // queue turns into a beep that keeps going long after the trigger is
    // released.
    /** User-configurable playback level, 0.0-1.0, see [setSoundVolume]. Applied
     *  to the synth-based tones' gain directly; the two `classic_*` ids play
     *  through [toneGen] instead, which is rebuilt at the matching ToneGenerator
     *  volume (0-100) whenever this changes. */
    @Volatile private var soundVolume = 1.0
    private var toneGen = ToneGenerator(AudioManager.STREAM_MUSIC, ToneGenerator.MAX_VOLUME)
    private val beepExec = Executors.newSingleThreadExecutor()
    @Volatile private var beepInFlight = false
    /**
     * Off for the Gate scan screen (see AppController._onReaderTrigger),
     * on everywhere else. The dense per-read tick below is right for a
     * screen whose whole point is "how fast can this reader go" (RFID
     * input/register/locate); it's wrong for Gate scanning, where the ask
     * is "one distinct sound per box actually added, silence for a repeat
     * read" — that discrete feedback is [playTone], driven from Dart once
     * addScan() knows whether a read was new, a duplicate, or rejected.
     */
    @Volatile private var autoBeepEnabled = true
    private fun beep() {
        if (!autoBeepEnabled || beepInFlight) return
        beepInFlight = true
        beepExec.execute {
            try {
                playSoundIdBlocking(rfidSoundId)
            } catch (e: Exception) {
                Log.w(TAG, "beep failed", e)
            } finally {
                beepInFlight = false
            }
        }
    }

    /** Explicit, app-driven tone — "ok" (short tick, a genuinely new tag
     *  landed) or "error" (longer low tone, scan rejected/invalid). Kept as a
     *  fixed, unconfigurable pair: only the "ok"/detection sound is meant to
     *  be user-chosen (see [playSoundId] and [rfidSoundId]), and Dart no
     *  longer calls this with "ok" — [playSoundId] replaced that case. The
     *  "error" case is still exactly what it always was.
     */
    private fun playTone(kind: String) {
        beepExec.execute {
            try {
                if (kind == "error") {
                    toneGen.startTone(ToneGenerator.TONE_CDMA_PIP, 220)
                } else {
                    toneGen.startTone(ToneGenerator.TONE_PROP_ACK, 70)
                }
            } catch (e: Exception) {
                Log.w(TAG, "playTone failed", e)
            }
        }
    }

    // ── Configurable sound catalog ──────────────────────────────────────────
    //
    // Every "a tag/box was detected" sound in the app funnels through
    // [playSoundId] with one of the ids below. Dart owns the *display* side of
    // this catalog (id -> Thai name, for the settings picker) in
    // sound_catalog.dart; this is the *playback* side, and the two id sets
    // must stay in sync by hand — there's no shared source of truth across the
    // platform channel for something this small.
    //
    // Two playback engines:
    //  - `synth` renders a short raw PCM waveform via AudioTrack. This is what
    //    lets "html_tick" be a genuine, sample-accurate port of the RFID HTML
    //    test page's WebAudio beep (square wave, 2700Hz, the same shaped
    //    envelope) rather than an approximation — ToneGenerator's fixed tones
    //    can't reproduce an arbitrary waveform/frequency.
    //  - The two "classic_*" ids replay ToneGenerator's existing system tones,
    //    kept as options because they're a completely different timbre (the
    //    phone's own DTMF-style tones) and because "classic_ack" is exactly
    //    what every barcode scan sounded like before this feature existed —
    //    picking it back is a no-op change for anyone who liked the old sound.
    /** Dispatches onto [beepExec] and returns immediately — the entry point
     *  for every external caller (settings preview, Dart's channel-driven ok
     *  tones — one call per box addScan() accepts, see AppController.addScan).
     *  [beep] does *not* call this: it is already running inside a [beepExec]
     *  task of its own, and dispatching a second one here would let that
     *  outer task's `finally { beepInFlight = false }` clear the in-flight
     *  flag before the inner, later-queued task actually finishes playing —
     *  defeating the whole point of the flag. It calls [playSoundIdBlocking]
     *  directly instead.
     *
     *  Drops rather than queues when a tone is already playing, same
     *  reasoning as [beep]: a Gate sweep can hand this ten calls in the same
     *  frame (ten new boxes landing in one batch — see
     *  AppController._onReaderBatch), and every one used to queue onto
     *  [beepExec] unconditionally. Each tone blocks for its own duration, so
     *  ten queued tones took ten tone-lengths to drain — the count on screen
     *  had already stopped moving while the beeps kept trickling out behind
     *  it, sounding sluggish and out of sync with what was actually
     *  happening. Dropping the excess instead keeps every tone that *does*
     *  play landing right on its box, at the cost of a batch of new boxes
     *  sometimes producing fewer ticks than boxes — the same trade [beep]
     *  already makes for the dense per-read case. */
    private fun playSoundId(id: String) {
        if (beepInFlight) return
        beepInFlight = true
        beepExec.execute {
            try {
                playSoundIdBlocking(id)
            } catch (e: Exception) {
                Log.w(TAG, "playSoundId($id) failed", e)
            } finally {
                beepInFlight = false
            }
        }
    }

    private fun playSoundIdBlocking(id: String) {
        when (id) {
            "none" -> {}
            "classic_beep" -> toneGen.startTone(ToneGenerator.TONE_PROP_BEEP, 40)
            "classic_ack" -> toneGen.startTone(ToneGenerator.TONE_PROP_ACK, 70)
            "html_tick" -> synth(Waveform.SQUARE, 2700.0, 50, 0.35)
            "soft_tick" -> synth(Waveform.SINE, 1800.0, 45, 0.3)
            "high_tick" -> synth(Waveform.SQUARE, 3400.0, 35, 0.3)
            "low_tick" -> synth(Waveform.SQUARE, 900.0, 70, 0.35)
            "ping" -> synth(Waveform.SINE, 2200.0, 90, 0.3)
            "double_tick" -> {
                synth(Waveform.SQUARE, 2400.0, 22, 0.32)
                Thread.sleep(18)
                synth(Waveform.SQUARE, 2400.0, 22, 0.32)
            }
            "grade_far" -> synth(Waveform.SQUARE, 900.0, 70, 0.55)
            "radar_tick" -> synth(Waveform.SQUARE, 900.0, 30, 0.55)
            "grade_warm" -> synth(Waveform.SINE, 1600.0, 55, 0.65)
            "grade_close" -> synth(Waveform.SQUARE, 2600.0, 45, 0.8)
            "grade_found" -> {
                // One tick at every grade: crossing the near threshold must
                // not abruptly double the perceived cadence.
                synth(Waveform.SQUARE, 3200.0, 45, 0.95)
            }
            // Putaway confirmation pair. Deliberately not in the settings
            // picker (sound_catalog.dart) for the same reason the grade_*
            // ids aren't: these say something specific about *what just
            // happened*, so letting them be reassigned would break the one
            // thing they exist for — an operator on a forklift knowing
            // "right shelf" from "wrong shelf" without looking at the screen.
            // Rising two-tone for right, rapid low triple for wrong: distinct
            // in shape as well as pitch, so they stay tellable apart over
            // warehouse noise and through ear protection.
            "putaway_ok" -> {
                synth(Waveform.SINE, 1800.0, 70, 0.38)
                synth(Waveform.SINE, 2700.0, 110, 0.4)
            }
            "putaway_err" -> {
                repeat(3) {
                    synth(Waveform.SQUARE, 700.0, 60, 0.4)
                    Thread.sleep(45)
                }
            }
            else -> Log.w(TAG, "playSoundId: unknown id \"$id\", playing nothing")
        }
    }

    private enum class Waveform { SINE, SQUARE }

    /**
     * Render and play one short tone as raw 16-bit PCM. Shaped with a fast
     * linear attack (10% of the duration) and a longer decay to silence — a
     * bare on/off gate clicks audibly at the start and end, which is the
     * first thing anyone doing this synthesis by hand runs into.
     *
     * Blocking (writes to the AudioTrack, then sleeps for its duration before
     * releasing it) — safe here only because every call already runs on
     * [beepExec], a dedicated single-thread executor never shared with the
     * SDK's read-callback thread.
     */
    private fun synth(wave: Waveform, freqHz: Double, durationMs: Int, gain: Double) {
        val gain = gain * soundVolume
        val sampleRate = 44100
        val frameCount = sampleRate * durationMs / 1000
        val samples = ShortArray(frameCount)
        val attackFrames = max(1, frameCount / 10)
        for (i in 0 until frameCount) {
            val t = i.toDouble() / sampleRate
            val raw = when (wave) {
                Waveform.SINE -> sin(2.0 * PI * freqHz * t)
                Waveform.SQUARE -> if (sin(2.0 * PI * freqHz * t) >= 0.0) 1.0 else -1.0
            }
            val envelope = when {
                i < attackFrames -> i.toDouble() / attackFrames
                else -> 1.0 - (i - attackFrames).toDouble() / (frameCount - attackFrames).coerceAtLeast(1)
            }.coerceIn(0.0, 1.0)
            samples[i] = (raw * envelope * gain * Short.MAX_VALUE).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }

        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        val track = AudioTrack.Builder()
            .setAudioAttributes(attrs)
            .setAudioFormat(format)
            .setBufferSizeInBytes(samples.size * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        try {
            track.write(samples, 0, samples.size)
            track.play()
            Thread.sleep(min(durationMs.toLong() + 20, 300))
        } finally {
            track.release()
        }
    }

    /** Which sound [beep] (the dense per-read RFID tick) plays, chosen from
     *  Settings and pushed down via "setRfidSoundId". Dart-driven ok tones
     *  (barcode and Gate's discrete RFID tick) don't need a native-side
     *  equivalent — Dart already knows which channel a detection came from
     *  and calls [playSoundId] directly with the right id. */
    @Volatile private var rfidSoundId = "html_tick"

    private val exec = Executors.newSingleThreadExecutor()
    private val connectInFlight = AtomicBoolean(false)

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
    @Volatile private var inventoryRunning = false
    // How many reads arrived with a TID already attached by the inventory
    // round. That piggyback is now the only source of a TID — the explicit
    // access-read fallback is gone, because it had to stop and restart
    // inventory around every call — so this is what tells "these tags don't
    // report a TID during inventory" apart from "the reader isn't reading".
    private var tidCount = 0L
    // Whether the physical gun trigger is currently held — readTidExplicit
    // stops inventory to run an access operation and uses this to decide
    // whether to start it again afterwards.
    @Volatile private var triggerHeld = false

    /** Selects the read profile — see [applyReadProfile]. Fast unless a screen
     *  that needs a TID (registration, and only registration) asks otherwise. */
    @Volatile private var detailMode = false

    // ── EventChannel.StreamHandler ────────────────────────────────────────
    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        sink = events
        pendingBarcode?.let { data ->
            pendingBarcode = null
            emit(mapOf("type" to "barcode", "data" to data))
        }
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
            "setRadarProfile" -> {
                val enabled = call.argument<Boolean>("enabled") == true
                exec.execute {
                    radarProfile = enabled
                    val rd = reader
                    if (rd?.isConnected == true) {
                        val resume = inventoryRunning
                        try {
                            stopReaderOperation()
                            val cfg = rd.Config.Antennas.getAntennaRfConfig(1)
                            cfg.setrfModeTableIndex((if (enabled) sensitiveRfModeIndex(rd) else fastestRfModeIndex(rd)).toLong())
                            rd.Config.Antennas.setAntennaRfConfig(1, cfg)
                        } catch (e: Exception) { Log.w(TAG, "RF profile unavailable", e) }
                        finally {
                            if (resume) {
                                try {
                                    val target = locateTarget
                                    if (target != null) rd.Actions.TagLocationing.Perform(target, null, null)
                                    else rd.Actions.Inventory.perform()
                                    locating = target != null
                                    inventoryRunning = true
                                    if (locating) watchLocate()
                                } catch (e: Exception) { Log.w(TAG, "RF resume unavailable", e) }
                            }
                        }
                    }
                }
                result.success(true)
            }
            "readTid" -> {
                val epc = call.argument<String>("epc") ?: ""
                exec.execute {
                    var tid: String? = null
                    try {
                        val rd = reader
                        // Only access a tag while idle; never interrupt inventory or barcode.
                        if (rd != null && RfidMetadataPolicy.mayReadTid(rd.isConnected, inventoryRunning, rfidTriggerMode, epc)) {
                            val params = TagAccess().ReadAccessParams()
                            params.setAccessPassword(0)
                            params.setMemoryBank(MEMORY_BANK.MEMORY_BANK_TID)
                            params.setOffset(0)
                            params.setCount(2)
                            rd.Config.setAccessOperationWaitTimeout(300)
                            tid = rd.Actions.TagAccess.readWait(epc, params, null)?.getMemoryBankData()
                        }
                    } catch (e: Exception) { Log.d(TAG, "Optional TID read unavailable", e) }
                    main.post { result.success(tid) }
                }
            }
            "setLocateTarget" -> {
                val target = call.argument<String>("epc")?.takeIf { it.isNotBlank() }
                exec.execute {
                    try {
                        val resume = inventoryRunning
                        stopReaderOperation()
                        locateTarget = target
                        if (resume && target != null && reader?.isConnected == true) {
                            reader!!.Actions.TagLocationing.Perform(target, null, null)
                            locating = true
                            inventoryRunning = true
                            watchLocate()
                        }
                    } catch (e: Exception) {
                        inventoryRunning = false
                        locating = false
                        locateTarget = null
                        try {
                            if (reader?.isConnected == true) {
                                reader!!.Actions.Inventory.perform()
                                inventoryRunning = true
                            }
                        } catch (fallback: Exception) { status("error", "เริ่มกวาดไม่ได้${why(fallback)}") }
                        Log.w(TAG, "Locate unavailable; using inventory RSSI", e)
                    }
                }
                result.success(true)
            }
            "startInventory" -> { startInventory(); result.success(true) }
            "stopInventory" -> { stopInventory(); result.success(true) }
            "setBarcodeTrigger" -> {
                val pressed = call.argument<Boolean>("pressed") == true
                // A late Dart press must not turn on the imager after RFID
                // has taken ownership. Release remains safe in either mode.
                if (!pressed || !rfidTriggerMode) {
                    val intent = Intent("com.symbol.datawedge.api.ACTION")
                    intent.putExtra("com.symbol.datawedge.api.SOFT_SCAN_TRIGGER",
                        if (pressed) "START_SCANNING" else "STOP_SCANNING")
                    context.sendBroadcast(intent)
                }
                result.success(true)
            }
            "setPower" -> { setPower(call.argument<Int>("percent") ?: 100); result.success(true) }
            "setPowerIndex" -> { setPowerIndex(call.argument<Int>("index") ?: maxPower); result.success(true) }
            "setAutoBeep" -> { autoBeepEnabled = call.argument<Boolean>("enabled") ?: true; result.success(true) }
            "playTone" -> { playTone(call.argument<String>("kind") ?: "ok"); result.success(true) }
            "setRfidSoundId" -> { rfidSoundId = call.argument<String>("soundId") ?: rfidSoundId; result.success(true) }
            "playSound" -> { playSoundId(call.argument<String>("soundId") ?: "none"); result.success(true) }
            "setSoundVolume" -> { setSoundVolume(call.argument<Double>("volume") ?: 1.0); result.success(true) }
            "setDetailMode" -> { setDetailMode(call.argument<Boolean>("enabled") == true); result.success(true) }
            "setBarcodeScannerEnabled" -> {
                setBarcodeScannerEnabled(call.argument<Boolean>("enabled") ?: true)
                result.success(true)
            }
            "prepareBarcodeDataWedge" -> {
                triggerModeManagedByRfidSdk = true
                ensureDataWedgeProfile()
                result.success(true)
            }
            "setRfidTriggerMode" -> {
                val enabled = call.argument<Boolean>("enabled") == true
                rfidTriggerMode = enabled
                triggerModeManagedByRfidSdk = true
                ensureDataWedgeProfile()
                if (!enabled) {
                    // API3 ENABLE_PLUGIN cannot revive scanner_input_enabled=false
                    // persisted by an earlier profile. Restore BARCODE parameters
                    // first; let asynchronous SET_CONFIG finish before API3 owns
                    // the trigger. Replay the LATEST mode, not this request,
                    // so a quick switch to RFID cannot re-enable barcode later.
                    val params = Bundle()
                    for ((key, value) in BarcodeScanPolicy.params(true)) {
                        params.putString(key, value)
                    }
                    sendDataWedgePluginConfig("BARCODE", params)
                    main.postDelayed({
                        exec.execute {
                            applyRfidTriggerMode(rfidTriggerMode)
                        }
                    }, 250)
                }
                // RFIDAPI3 can block for seconds while the reader changes
                // transport/trigger ownership. Never run it on Android's UI
                // thread: a tap during that call otherwise becomes an ANR.
                exec.execute {
                    if (enabled == rfidTriggerMode && !applyRfidTriggerMode(enabled)) {
                        main.post { status("error", "RFID SDK สลับโหมด Trigger ไม่สำเร็จ") }
                    }
                }
                result.success(true)
            }
            "isConnected" -> result.success(isConnected())
            "diagnostics" -> exec.execute {
                val snapshot = diagnostics()
                main.post { result.success(snapshot) }
            }
            "deviceInfo" -> result.success(deviceInfo())
            else -> result.notImplemented()
        }
    }

    private fun isConnected(): Boolean = reader?.isConnected == true

    /** DataWedge profile this app owns — see [ensureDataWedgeProfile]. */
    private val dataWedgeProfileName = "SmartTracePDA"
    private var dataWedgeProfileEnsured = false
    @Volatile private var barcodeScannerEnabled = true
    @Volatile private var rfidTriggerMode = false
    @Volatile private var triggerModeManagedByRfidSdk = false

    /**
     * Changes the integrated reader's shared side trigger using RFIDAPI3.
     * RFIDAPI3 owns scanner-plugin state for integrated readers. The SDK's
     * second argument must therefore be true; issuing both SDK and DataWedge
     * scanner toggles races and can leave the imager active in RFID mode.
     * Remembering the desired mode lets a toggle made during connection be
     * applied as soon as configureReader() finishes.
     */
    private fun applyRfidTriggerMode(enabled: Boolean): Boolean {
        val rd = reader ?: return true // queued; configureReader applies it
        if (!rd.isConnected) return true
        // Key-layout mapping is not implemented by every API3 transport / SDK
        // build (notably older integrated-reader firmware). Treat that mapping
        // as best-effort; an exception here must not prevent API3 from switching
        // the actual RFID-vs-barcode trigger mode below.
        try {
            rd.Config.setKeylayoutType(
                if (enabled) ENUM_KEYLAYOUT_TYPE.UPPER_TRIGGER_FOR_RFID
                else ENUM_KEYLAYOUT_TYPE.UPPER_TRIGGER_FOR_SCAN
            )
        } catch (e: Exception) {
            Log.w(TAG, "key-layout mapping unavailable; applying trigger mode anyway", e)
        }
        return try {
            val applied = rd.Config.setTriggerMode(
                if (enabled) ENUM_TRIGGER_MODE.RFID_MODE else ENUM_TRIGGER_MODE.BARCODE_MODE,
                true
            )
            Log.i(TAG, "upper trigger mapped to ${if (enabled) "RFID" else "SCAN"}; mode applied=$applied")
            applied
        } catch (e: Exception) {
            Log.e(TAG, "failed to switch physical trigger mode", e)
            lastError = "trigger mode: ${e.message ?: e.javaClass.simpleName}"
            false
        }
    }

    /**
     * Broadcast DataWedge uses to hand this app the whole decoded barcode.
     * Keystroke output alone types into whichever field is focused, so on
     * the gate-out form the label lands in ทะเบียนรถ/คนขับ and never becomes
     * a queued box — the scanner clearly read something, and ส่งออก still
     * has nothing to commit.
     */
    private val scanAction = "${context.packageName}.SCAN"
    private var scanReceiverRegistered = false

    private var pendingBarcode: String? = null

    private val scanReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            if (intent?.action != scanAction) return
            val data = intent.getStringExtra("com.symbol.datawedge.data_string")
                ?: intent.getStringExtra("com.motorolasolutions.emdk.datawedge.data_string")
                ?: return
            if (data.isBlank()) return
            if (sink == null) {
                pendingBarcode = data
            } else {
                emit(mapOf("type" to "barcode", "data" to data))
            }
        }
    }

    init {
        registerScanReceiver()
    }

    private fun registerScanReceiver() {
        if (scanReceiverRegistered) return
        val filter = IntentFilter(scanAction)
        filter.addCategory(Intent.CATEGORY_DEFAULT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(scanReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(scanReceiver, filter)
        }
        scanReceiverRegistered = true
    }

    /**
     * Creates (idempotent) and associates a DataWedge profile with this
     * app's package before the first [setBarcodeScannerEnabled] call.
     *
     * Without an app-owned profile, this app runs under DataWedge's
     * "Profile0" — the catch-all default for unassociated apps — where
     * runtime plugin toggles observably don't stick (confirmed on-device:
     * DISABLE_PLUGIN broadcasts are received and processed by DataWedge's
     * ScanningService, yet the physical imager keeps arming/illuminating
     * on trigger pull). Giving the app its own profile is what every
     * DataWedge integration guide assumes as the starting point; Profile0
     * is meant to be left alone.
     *
     * KEYSTROKE stays enabled as a fallback for fields that still read the
     * wedge. INTENT is what actually submits a scan: one broadcast with the
     * full code, independent of which text field happens to be focused.
     */
    private fun ensureDataWedgeProfile() {
        registerScanReceiver()
        if (dataWedgeProfileEnsured) return
        dataWedgeProfileEnsured = true
        applyDataWedgeProfile()
        // CREATE_PROFILE is asynchronous. A SET_CONFIG in the same turn is
        // often dropped the first time the profile is born, which leaves the
        // imager decoding into nowhere. Apply again once DataWedge has had
        // a moment to create it.
        main.postDelayed({
            applyDataWedgeProfile()
            // Profile creation/switching is asynchronous. Reapply the latest
            // desired scanner state after DataWedge has finished activating
            // the app profile, otherwise its default barcode plugin can steal
            // the shared side trigger in RFID test mode.
            if (triggerModeManagedByRfidSdk) {
                // PROFILE creation/switching can reset the shared scanner
                // trigger after an earlier RFIDAPI3 call. Re-assert the most
                // recently requested SDK mode only after DataWedge has
                // finished activating this profile; never enable/disable its
                // scanner plugin in parallel with RFIDAPI3.
                exec.execute {
                    val applied = applyRfidTriggerMode(rfidTriggerMode)
                    if (!applied) {
                        main.post { status("error", "RFID SDK สลับโหมด Trigger ไม่สำเร็จ") }
                    }
                }
            } else {
                applyBarcodeScannerState(barcodeScannerEnabled)
            }
        }, 600)
    }

    private fun applyDataWedgeProfile() {
        sendDataWedge("com.symbol.datawedge.api.CREATE_PROFILE", dataWedgeProfileName)

        val appConfig = Bundle()
        appConfig.putString("PACKAGE_NAME", context.packageName)
        appConfig.putStringArray("ACTIVITY_LIST", arrayOf("*"))

        val profileConfig = Bundle()
        profileConfig.putString("PROFILE_NAME", dataWedgeProfileName)
        profileConfig.putString("PROFILE_ENABLED", "true")
        profileConfig.putString("CONFIG_MODE", "UPDATE")
        profileConfig.putParcelableArray("APP_LIST", arrayOf(appConfig))
        sendDataWedgeConfig(profileConfig)

        val keystrokeParams = Bundle()
        keystrokeParams.putString("keystroke_output_enabled", "true")
        sendDataWedgePluginConfig("KEYSTROKE", keystrokeParams)

        val intentParams = Bundle()
        intentParams.putString("intent_output_enabled", "true")
        intentParams.putString("intent_action", scanAction)
        intentParams.putString("intent_category", Intent.CATEGORY_DEFAULT)
        intentParams.putString("intent_delivery", "2")
        sendDataWedgePluginConfig("INTENT", intentParams)

        sendDataWedge("com.symbol.datawedge.api.SWITCH_TO_PROFILE", dataWedgeProfileName)
    }

    /**
     * Arms/disarms the handheld's *barcode* imager (laser/LED/beep) via
     * DataWedge's public intent API — separate from the RFID antenna, which
     * is entirely on the RFIDAPI3 side above. Without this, DataWedge owns
     * the same physical trigger the RFID SDK listens to, so picking "RFID"
     * in the app's scan-mode toggle silenced the antenna on our side but
     * left DataWedge free to also decode a barcode (light/beep and all) on
     * the same trigger pull, and vice versa in barcode mode.
     *
     * Targets this app's own profile (see [ensureDataWedgeProfile]) via
     * SET_CONFIG rather than only the quick SCANNERINPUTPLUGIN command —
     * the latter alone was observed not to stick while running under
     * Profile0. Both are sent; SCANNERINPUTPLUGIN is a harmless no-op once
     * the profile-scoped config is what's actually taking effect.
     *
     * No EMDK license needed — DataWedge ships pre-installed on Zebra
     * devices and listens for these broadcasts system-wide.
     */
    private fun setBarcodeScannerEnabled(enabled: Boolean) {
        barcodeScannerEnabled = enabled
        ensureDataWedgeProfile()

        applyBarcodeScannerState(enabled)
    }

    private fun applyBarcodeScannerState(enabled: Boolean) {
        val barcodeParams = Bundle()
        // RESET_CONFIG below wipes the barcode plugin, so the hold-to-scan
        // aim type has to travel with every enable. Otherwise DataWedge
        // falls back to one decode per trigger press.
        for ((key, value) in BarcodeScanPolicy.params(enabled)) {
            barcodeParams.putString(key, value)
        }
        sendDataWedgePluginConfig("BARCODE", barcodeParams)

        val intent = Intent()
        intent.action = "com.symbol.datawedge.api.ACTION"
        intent.putExtra(
            "com.symbol.datawedge.api.SCANNERINPUTPLUGIN",
            if (enabled) "ENABLE_PLUGIN" else "DISABLE_PLUGIN"
        )
        context.sendBroadcast(intent)
    }

    private fun sendDataWedge(extraName: String, extraValue: String) {
        val intent = Intent()
        intent.action = "com.symbol.datawedge.api.ACTION"
        intent.putExtra(extraName, extraValue)
        context.sendBroadcast(intent)
    }

    private fun sendDataWedgeConfig(profileConfig: Bundle) {
        val intent = Intent()
        intent.action = "com.symbol.datawedge.api.ACTION"
        intent.putExtra("com.symbol.datawedge.api.SET_CONFIG", profileConfig)
        context.sendBroadcast(intent)
    }

    private fun sendDataWedgePluginConfig(pluginName: String, params: Bundle) {
        val pluginConfig = Bundle()
        pluginConfig.putString("PLUGIN_NAME", pluginName)
        pluginConfig.putString("RESET_CONFIG", "true")
        pluginConfig.putBundle("PARAM_LIST", params)

        val profileConfig = Bundle()
        profileConfig.putString("PROFILE_NAME", dataWedgeProfileName)
        profileConfig.putString("PROFILE_ENABLED", "true")
        profileConfig.putString("CONFIG_MODE", "UPDATE")
        // MC3390R DataWedge expects ArrayList even for one plugin. A single
        // Bundle is rejected, leaving INTENT output/scanner configuration stale.
        profileConfig.putParcelableArrayList("PLUGIN_CONFIG", arrayListOf(pluginConfig))
        sendDataWedgeConfig(profileConfig)
    }

    /**
     * What the OS itself says this handheld actually is — independent of
     * whether a Zebra RFID reader ever answers. device_setup_screen.dart
     * uses this to decide whether the "Zebra MC3300 Series (MC3390R)"
     * profile is honest to show at all: [diagnostics] only knows the reader
     * model, and only once one has connected, so on its own it can't tell
     * "this is genuinely an MC3390R that hasn't connected yet" apart from
     * "this is some other Android device entirely" — Build.MANUFACTURER/
     * MODEL/BRAND can, immediately, with no reader involved.
     */
    private fun deviceInfo(): Map<String, Any?> {
        val integratedRfid = runCatching {
            val properties = Class.forName("android.os.SystemProperties")
            val get = properties.getMethod("get", String::class.java)
            val type = get.invoke(null, "ro.config.device.rfidtype").toString().toIntOrNull() ?: 0
            val service = get.invoke(null, "init.svc.rfidflinger").toString()
            type > 0 || service == "running"
        }.getOrDefault(false)
        return mapOf(
            "hasIntegratedRfid" to integratedRfid,
            "manufacturer" to Build.MANUFACTURER,
            "model" to Build.MODEL,
            "brand" to Build.BRAND,
            "androidRelease" to Build.VERSION.RELEASE,
        )
    }

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
        m["tidCount"] = tidCount

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
            /* The link profile in force, and the fastest the reader says it
               has. Surfaced because read rate lives or dies on it and the
               app's own logs aren't readable on a locked-down device — this
               panel is the only way to see, on the floor, whether the radio
               is actually on its quickest setting. */
            m["rfModeIndex"] = num {
                rd.Config.Antennas.getAntennaRfConfig(1).getrfModeTableIndex().toInt()
            }
            m["rfModeBdr"] = num { bdrForModeIndex(rd, rd.Config.Antennas.getAntennaRfConfig(1).getrfModeTableIndex().toInt()) }
            m["rfModeBest"] = num { fastestRfModeIndex(rd) }
            m["rfModeCount"] = num { rfModeEntryCount(rd) }
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
        if (!connectInFlight.compareAndSet(false, true)) return
        status("connecting", "กำลังค้นหาเครื่องอ่าน…")
        exec.execute {
            val preferredName = RfidTransportPolicy.preferred(Build.MODEL)
            val isTc501 = preferredName == "QC_SERIAL"
            try {
                // TC501's QC_SERIAL path must retain the Activity context passed
                // to Readers(this, QC_SERIAL). The legacy API3Utils workaround
                // replaces that context with applicationContext and can make
                // Qualcomm's QC transport fail to open on TC501.
                if (!isTc501) patchApi3UtilsContext()
                val preferredTransport = if (isTc501) {
                    // TC501's integrated reader is exposed through Qualcomm's
                    // serial service, not the legacy SERVICE_SERIAL transport
                    // used by MC33xx. QC_SERIAL was added in RFID SDK 2.0.5.x.
                    // Resolve it by name so this source still builds against
                    // older SDK bundles, and fail with an actionable message
                    // rather than opening the wrong transport on TC501.
                    try {
                        java.lang.Enum.valueOf(
                            ENUM_TRANSPORT::class.java,
                            preferredName,
                        )
                    } catch (_: IllegalArgumentException) {
                        lastTransport = "QC_SERIAL (SDK required: 2.0.5.292+)"
                        lastError = "TC501 ต้องใช้ Zebra RFID SDK 2.0.5.292 ขึ้นไป"
                        status("error", lastError!!)
                        return@execute
                    }
                } else {
                    ENUM_TRANSPORT.SERVICE_SERIAL
                }
                // Recreate the SDK manager when switching between a previous
                // transport and the model-specific one.
                readers?.Dispose()
                readers = Readers(context, preferredTransport)
                // attach/deattach are static on Readers, not instance methods
                Readers.attach(this)

                var list = safeList()
                lastTransport = RfidTransportPolicy.preferred(Build.MODEL)
                Log.i(TAG, "reader enumeration transport=$lastTransport count=${list.size}")
                // TC501 must stay on QC_SERIAL; SERVICE_SERIAL, BT and USB
                // are not valid fallbacks for its integrated reader.
                // MC3390R = SERVICE_SERIAL; fall back to sled / USB like the sample.
                if (RfidTransportPolicy.allowsAlternateTransport(Build.MODEL) && list.isEmpty()) {
                    readers?.setTransport(ENUM_TRANSPORT.BLUETOOTH); list = safeList(); lastTransport = "BLUETOOTH"
                }
                if (RfidTransportPolicy.allowsAlternateTransport(Build.MODEL) && list.isEmpty()) {
                    readers?.setTransport(ENUM_TRANSPORT.SERVICE_USB); list = safeList(); lastTransport = "SERVICE_USB"
                }
                if (list.isEmpty()) {
                    lastTransport = null
                    status("error", "ไม่พบเครื่องอ่าน RFID")
                    return@execute
                }

                val rd = list[0].getRFIDReader()
                reader = rd
                Log.i(TAG, "connecting reader host=${rd.getHostName()} transport=$lastTransport")

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
                    Log.i(TAG, "reader connected host=${rd.getHostName()} transport=$lastTransport")
                } else {
                    status("error", "เชื่อมต่อไม่สำเร็จ")
                }
            } catch (e: Exception) {
                val detail = if (e is OperationFailureException) {
                    " (${e.getResults()}${e.getVendorMessage()?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""})"
                } else ""
                inventoryRunning = false
                Log.e(TAG, "connect failed$detail", e)
                // A failed QC open can leave an SDK transport/reader handle
                // behind. Release it before allowing the next reconnect attempt.
                try { reader?.let { if (it.isConnected) it.disconnect() } }
                catch (cleanup: Exception) { Log.w(TAG, "failed reader disconnect cleanup", cleanup) }
                reader = null
                try { readers?.Dispose() }
                catch (cleanup: Exception) { Log.w(TAG, "failed readers transport cleanup", cleanup) }
                readers = null
                status("error", (e.message ?: "เชื่อมต่อไม่สำเร็จ") + detail)
            } finally {
                connectInFlight.set(false)
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
            rd.Events.setReaderDisconnectEvent(true)

            val trigger = TriggerInfo()
            trigger.StartTrigger.setTriggerType(START_TRIGGER_TYPE.START_TRIGGER_TYPE_IMMEDIATE)
            trigger.StopTrigger.setTriggerType(STOP_TRIGGER_TYPE.STOP_TRIGGER_TYPE_IMMEDIATE)
            rd.Config.setStartTrigger(trigger.StartTrigger)
            rd.Config.setStopTrigger(trigger.StopTrigger)

            // The same side trigger can control either the RFID radio or the
            // barcode imager. Select the SDK trigger mode for the app's
            // current screen/mode before the operator presses it.
            applyRfidTriggerMode(rfidTriggerMode)

            // power: index-based, take the maximum supported
            maxPower = rd.ReaderCapabilities.getTransmitPowerLevelValues().size - 1
            val cfg = rd.Config.Antennas.getAntennaRfConfig(1)
            cfg.setTransmitPowerIndex(maxPower)
            // The link profile: was hardcoded to index 0, which is simply
            // "whatever the SDK lists first" and carries no promise of being
            // the fast one. Each entry in the reader's own RF mode table
            // reports its backscatter data rate (bdrValue, bits/sec) — the
            // rate tag replies come back at, and the single biggest lever on
            // how many reads/sec this radio can do. So ask the reader what it
            // supports and take the fastest, instead of assuming.
            //
            // Every entry is logged: the table is firmware- and region-
            // dependent, so this is also how we can see on a real device what
            // was actually available and what got picked.
            cfg.setrfModeTableIndex((if (radarProfile) sensitiveRfModeIndex(rd) else fastestRfModeIndex(rd)).toLong())
            cfg.setTari(0L) // 0 = let the reader use the chosen mode's own default
            rd.Config.Antennas.setAntennaRfConfig(1, cfg)

            // Singulation. The comment here used to claim "state A — read tags
            // continuously while triggered", which is precisely what target A
            // does NOT do.
            //
            // Gen2: a tag that answers an inventory round flips its inventoried
            // flag A->B, and in S0 that flag holds for as long as the tag stays
            // energised. The reader's field is continuous while the trigger is
            // held, so a tag read once sits in B and simply stops answering the
            // A queries the reader keeps sending. One read per tag, then
            // silence — the "เจอแล้วไม่รัวต่อ" symptom, and the reason reads
            // trickled in at roughly one a second instead of streaming: what
            // arrived was tags briefly dropping out of the field and resetting,
            // not the reader working.
            //
            // AB_FLIP alternates the target between rounds, so the tags now
            // sitting in B answer the next round (flipping back to A), and so
            // on. That is what makes a held trigger re-read the same tags over
            // and over at the reader's real rate.
            val s = rd.Config.Antennas.getSingulationControl(1)
            s.setSession(SESSION.SESSION_S0)
            s.Action.setInventoryState(INVENTORY_STATE.INVENTORY_STATE_AB_FLIP)
            s.Action.setSLFlag(SL_FLAG.SL_ALL)
            // Gen2 sizes its slot count as 2^Q, and this estimate is what
            // picks the STARTING Q. 300 was set here to help a dense pallet
            // sweep, and it did the opposite of what its own comment claimed:
            // 300 starts Q at ~8, i.e. 256 slots per inventory round. Point
            // the reader at four tags — the settings-screen read test, or a
            // handful of boxes at the gate — and ~252 of those slots are
            // empty air the reader still has to clock through before the
            // round ends. That is exactly the "1… 2… 3… 4…" crawl.
            //
            // Dynamic Q is self-correcting, but only in one direction in
            // practice: it ratchets Q *up* fast when it sees collisions and
            // creeps it back *down* slowly across many empty slots. So the
            // starting estimate should be biased LOW — a handheld sees a
            // handful of tags almost every time, and the rare dense pallet
            // costs a few collisions before Q climbs to fit it. Starting
            // high, as before, taxed every single read for a case that
            // almost never happens.
            s.setTagPopulation(16)
            rd.Config.Antennas.setSingulationControl(1, s)

            rd.Actions.PreFilters.deleteAll()

            applyReadProfile(rd)
        } catch (e: Exception) {
            Log.e(TAG, "configure failed", e)
        }
    }

    /**
     * The reader's fastest Gen2 link profile, as an RF-mode-table index.
     *
     * `bdrValue` is the entry's backscatter data rate in bits/sec — how fast a
     * tag's reply comes back over the air. Everything else being equal, the
     * highest one gives the most reads/sec, which is the whole reason this
     * function exists instead of the old hardcoded 0.
     *
     * Falls back to 0 (the previous behaviour) if the table can't be read or
     * comes back empty, so a firmware that doesn't expose it is no worse off
     * than before.
     */
    /** Backscatter data rate of one mode index, or -1 if the table has no
     *  such entry — see [fastestRfModeIndex] for what bdr means here. */
    private fun bdrForModeIndex(rd: RFIDReader, index: Int): Int {
        val modes = rd.ReaderCapabilities.RFModes
        for (t in 0 until modes.Length()) {
            val table = modes.getRFModeTableInfo(t) ?: continue
            for (i in 0 until table.length()) {
                val e = table.getRFModeTableEntryInfo(i) ?: continue
                if (e.getModeIdentifer() == index) return e.getBdrValue()
            }
        }
        return -1
    }

    private fun rfModeEntryCount(rd: RFIDReader): Int {
        val modes = rd.ReaderCapabilities.RFModes
        var n = 0
        for (t in 0 until modes.Length()) n += (modes.getRFModeTableInfo(t)?.length() ?: 0)
        return n
    }

    private fun fastestRfModeIndex(rd: RFIDReader): Int {
        try {
            val modes = rd.ReaderCapabilities.RFModes
            var bestIndex = 0
            var bestBdr = -1
            var found = 0
            for (t in 0 until modes.Length()) {
                val table = modes.getRFModeTableInfo(t) ?: continue
                for (i in 0 until table.length()) {
                    val e = table.getRFModeTableEntryInfo(i) ?: continue
                    found++
                    Log.i(
                        TAG,
                        "rf mode[$t/$i] id=${e.getModeIdentifer()} bdr=${e.getBdrValue()}" +
                            " mod=${e.getModulation()} dr=${e.getDivideRatio()}" +
                            " tari=${e.getMinTariValue()}..${e.getMaxTariValue()}"
                    )
                    if (e.getBdrValue() > bestBdr) {
                        bestBdr = e.getBdrValue()
                        bestIndex = e.getModeIdentifer()
                    }
                }
            }
            if (found == 0) {
                Log.w(TAG, "rf mode table empty — keeping index 0")
                return 0
            }
            Log.i(TAG, "rf mode: picked index=$bestIndex (bdr=$bestBdr bps) out of $found entries")
            return bestIndex
        } catch (e: Exception) {
            Log.w(TAG, "rf mode table unavailable — keeping index 0", e)
            return 0
        }
    }

    private var radarProfile = false
    private fun sensitiveRfModeIndex(rd: RFIDReader): Int {
        var chosen = fastestRfModeIndex(rd)
        var rate = Int.MAX_VALUE
        val modes = rd.ReaderCapabilities.RFModes
        for (t in 0 until modes.Length()) {
            val table = modes.getRFModeTableInfo(t) ?: continue
            for (i in 0 until table.length()) {
                val entry = table.getRFModeTableEntryInfo(i) ?: continue
                if (entry.getBdrValue() > 0 && entry.getBdrValue() < rate) {
                    rate = entry.getBdrValue()
                    chosen = entry.getModeIdentifer()
                }
            }
        }
        return chosen
    }

    /**
     * Put the reader into whichever of the two read profiles [detailMode]
     * currently selects. Called on connect and again on every mode change,
     * because these are reader-side settings that persist until overwritten —
     * leaving detail mode does nothing unless the fast values are pushed back.
     *
     * **Fast (default, every screen but rfid_input_screen)** — what the
     * terminal does 99% of the time: sweep a pallet and collect EPCs. It
     * matches rfid_html_app's configuration exactly, which is the only
     * configuration measured at full reader speed on this hardware:
     *
     *  - `setAttachTagDataWithReadEvent(false)` — no TagData rides along on the
     *    event; the read loop pulls the EPC and nothing else.
     *  - Tag fields cut to PEAK_RSSI alone. `ALL_TAG_FIELDS` makes the reader
     *    report TID/PC/CRC/XPC/phase/channel/timestamps for every tag on every
     *    round, and nothing outside the RFID test screen looks at any of it.
     *
     * **Detail (rfid_input_screen only)** — that screen's whole purpose is
     * showing every field the SDK can report per tag, so `ALL_TAG_FIELDS`
     * goes on. DPO stays off regardless — see setDPOState's own comment
     * below on why detail mode no longer has a reason to want it on.
     * Deliberately does *not* chase a TID with an explicit per-tag
     * access-read the way an earlier version of this file did: that call
     * stops and restarts inventory around every tag, and cost this exact
     * screen its read rate the one time it was wired up (171/sec ->
     * ~16/sec) for a field ([tidCount] confirms) this reader's inventory
     * round never carries anyway.
     */
    private fun applyReadProfile(rd: RFIDReader) {
        val detail = detailMode
        try {
            rd.Events.setAttachTagDataWithReadEvent(detail)
        } catch (e: Exception) {
            Log.w(TAG, "setAttachTagDataWithReadEvent failed", e)
        }
        try {
            val storage = rd.Config.getTagStorageSettings()
            // setTagFields *replaces* the reported set rather than adding to
            // it, so the fast list really is "RSSI only" — EPC is the tag ID
            // itself and always comes back regardless.
            storage.setTagFields(
                if (detail) arrayOf(TAG_FIELD.ALL_TAG_FIELDS) else arrayOf(TAG_FIELD.PEAK_RSSI)
            )
            rd.Config.setTagStorageSettings(storage)
        } catch (e: Exception) {
            Log.w(TAG, "tag-field reporting config failed", e)
        }
        try {
            // Always off now, detail mode included. DPO trades read *rate*
            // for battery, which only ever made sense back when detail mode
            // also meant "one tag held still, chase its TID with an explicit
            // access-read" — a slow, deliberate operation DPO's overhead
            // didn't add much to. That explicit-TID path is gone (see
            // eventReadNotify's comment on why); every current use of
            // detail mode is rfid_input_screen sweeping tags for the rest
            // of their fields as fast as it can, which is exactly the read
            // rate DPO would trade away.
            rd.Config.setDPOState(DYNAMIC_POWER_OPTIMIZATION.DISABLE)
        } catch (e: Exception) {
            Log.w(TAG, "DPO config failed", e)
        }
        Log.i(TAG, "read profile: ${if (detail) "detail (all fields, DPO off)" else "fast (EPC+RSSI, DPO off)"}")
    }

    fun disconnect() {
        exec.execute {
            try {
                reader?.let { rd ->
                    eventHandler?.let { rd.Events.removeEventsListener(it) }
                    if (rd.isConnected) {
                        if (inventoryRunning) {
                            try { stopReaderOperation() } catch (e: Exception) {
                                Log.w(TAG, "inventory stop during disconnect failed", e)
                            }
                        }
                        rd.disconnect()
                    }
                }
                inventoryRunning = false
                status("disconnected", "ตัดการเชื่อมต่อแล้ว")
            } catch (e: Exception) {
                Log.w(TAG, "disconnect failed", e)
            }
        }
    }

    @Volatile private var locateTarget: String? = null
    @Volatile private var locating = false
    @Volatile private var locateEpoch = 0L
    @Volatile private var locateReadEpoch = -1L

    /** A successful Perform call does not guarantee firmware will report tags. */
    private fun watchLocate() {
        val epoch = ++locateEpoch
        main.postDelayed({
            exec.execute {
                if (!RfidLocatePolicy.shouldFallback(epoch == locateEpoch,
                        inventoryRunning && locating, reader?.isConnected == true,
                        rfidTriggerMode, locateReadEpoch == epoch)) return@execute
                try {
                    stopReaderOperation()
                    locateTarget = null
                    reader!!.Actions.Inventory.perform()
                    inventoryRunning = true
                    Log.w(TAG, "Locate returned no tags; resumed inventory RSSI")
                } catch (e: Exception) {
                    status("error", "เริ่มกวาดสำรองไม่ได้${why(e)}")
                }
            }
        }, 1200)
    }

    private fun stopReaderOperation() {
        locateEpoch++
        val rd = reader ?: return
        if (!rd.isConnected || !inventoryRunning) return
        try {
            if (locating) {
                val operation = rd.Actions.TagLocationing
                operation.javaClass.methods.first { it.name.equals("stop", true) && it.parameterCount == 0 }.invoke(operation)
            } else rd.Actions.Inventory.stop()
        } finally {
            inventoryRunning = false
            locating = false
        }
    }

    fun startInventory() {
        exec.execute {
            try {
                Log.i(TAG, "startInventory: reader=$reader isConnected=${reader?.isConnected}")
                val rd = reader ?: return@execute
                if (!rd.isConnected) return@execute
                val target = locateTarget
                if (target != null) {
                    rd.Actions.TagLocationing.Perform(target, null, null)
                    locating = true
                } else {
                    rd.Actions.Inventory.perform()
                    locating = false
                }
                inventoryRunning = true
                if (locating) watchLocate()
            } catch (e: Exception) {
                // "already inventorying" is the expected answer to a second
                // start — a held trigger while a screen also calls
                // startInventory(), or two press events for one pull. It is
                // not a failure and must not surface as one.
                if (e is OperationFailureException &&
                    e.getResults() == RFIDResults.RFID_OPERATION_IN_PROGRESS) {
                    Log.d(TAG, "startInventory ignored — inventory already running")
                    inventoryRunning = true
                    return@execute
                }
                inventoryRunning = false
                Log.w(TAG, "startInventory failed${why(e)}", e)
                // Surfaced, not just logged: the MC3390R answers
                // RFID_CHARGING_COMMAND_NOT_ALLOWED to every inventory command
                // while the battery is charging, so a terminal sitting in its
                // cradle looks exactly like a broken app. Without the reason on
                // screen there is nothing to tell an operator to take it off
                // the charger.
                status("error", "เริ่มอ่านไม่ได้${why(e)}")
            }
        }
    }

    /**
     * `OperationFailureException.toString()` carries no message at all, so an
     * unadorned log line is a class name and a stack trace — enough to know the
     * command failed, nothing to say why. The result code is the only thing
     * that tells "charging, command refused" apart from "region not configured"
     * or "another app owns the reader".
     */
    private fun why(e: Exception): String =
        if (e is OperationFailureException) " (${e.getResults()}: ${e.getVendorMessage()})" else ""

    fun stopInventory() {
        exec.execute {
            try {
                val rd = reader ?: return@execute
                if (!rd.isConnected || !inventoryRunning) return@execute
                stopReaderOperation()
            } catch (e: Exception) {
                Log.w(TAG, "stopInventory failed", e)
            }
        }
    }

    /** Sets the RFID detection sound's playback level, 0.0-1.0. Rebuilds
     *  [toneGen] at the matching ToneGenerator volume (its own 0-100 scale) so
     *  `classic_beep`/`classic_ack` track it too, not just the synth tones. */
    fun setSoundVolume(volume: Double) {
        soundVolume = volume.coerceIn(0.0, 1.0)
        try {
            toneGen.release()
        } catch (e: Exception) {
            Log.w(TAG, "toneGen release failed", e)
        }
        val level = (soundVolume * ToneGenerator.MAX_VOLUME).toInt().coerceIn(1, ToneGenerator.MAX_VOLUME)
        toneGen = ToneGenerator(AudioManager.STREAM_MUSIC, level)
    }

    fun setDetailMode(enabled: Boolean) {
        if (detailMode == enabled) return
        detailMode = enabled
        exec.execute {
            val rd = reader ?: return@execute
            if (rd.isConnected) applyReadProfile(rd)
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

    /**
     * Same knob as [setPower], but takes the reader's own power index
     * directly instead of a 0-100 percent. A percent can only ever land on
     * ~101 of the reader's real steps (this hardware's index range runs well
     * past 100), so a settings slider driven by percent skips most of what
     * the antenna can actually do. This is what lets the slider cover every
     * index the reader has, 0 through [maxPower].
     */
    fun setPowerIndex(index: Int) {
        exec.execute {
            try {
                val rd = reader ?: return@execute
                val idx = index.coerceIn(0, maxPower)
                val cfg = rd.Config.Antennas.getAntennaRfConfig(1)
                cfg.setTransmitPowerIndex(idx)
                rd.Config.Antennas.setAntennaRfConfig(1, cfg)
            } catch (e: Exception) {
                Log.w(TAG, "setPowerIndex failed", e)
            }
        }
    }

    fun dispose() {
        try {
            if (scanReceiverRegistered) {
                context.unregisterReceiver(scanReceiver)
                scanReceiverRegistered = false
            }
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

    // ── SDK read/status callbacks ─────────────────────────────────────────
    inner class EventHandler : RfidEventsListener {
        override fun eventReadNotify(e: RfidReadEvents?) {
            val rd = reader ?: return
            // 1000, not 100: at ~170-180 tags/sec a dense burst between two
            // callback turns can queue more than 100 reads in the SDK's own
            // buffer, and getReadTags(100) would silently leave the rest for
            // next time (or never, if the trigger releases first) — this
            // just asks for everything currently buffered in one call.
            val tags: Array<TagData>? = rd.Actions.getReadTags(1000)
            if (tags == null || tags.isEmpty()) return

            // Sort by peak RSSI descending so near tags (strongest signal) come first.
            val sortedTags = tags.sortedByDescending { it.getPeakRSSI().toInt() }

            // One tick for the whole event rather than one per tag. At reader
            // speed the difference is inaudible — tones this close together
            // merge anyway — but it keeps the beep from being the thing that
            // paces the read loop.
            beep()

            val detail = detailMode
            val batch = ArrayList<Map<String, Any?>>(sortedTags.size)
            for (t in sortedTags) {
                tagCount++
                val epc = t.getTagID()
                if (locating && epc.equals(locateTarget, true)) locateReadEpoch = locateEpoch
                lastEpc = epc
                lastRssi = t.getPeakRSSI().toInt()

                if (!detail) {
                    // Fast path: two getters and nothing else. Every field
                    // below costs a getter call wrapped in its own try/catch,
                    // per tag, on the SDK's read-callback thread — the thread
                    // that should be going back for the next batch. Outside
                    // registration nothing reads them.
                    val proximity = if (t.isContainsLocationInfo()) t.LocationInfo.getRelativeDistance().toInt() else null
                    batch.add(mapOf("epc" to epc, "rssi" to lastRssi, "proximity" to proximity))
                    continue
                }

                // Every field ALL_TAG_FIELDS attaches "for free" alongside the
                // inventory round — no extra SDK call, just more of the same
                // struct already in hand. TID deliberately is NOT chased with
                // an explicit access-read here anymore: that call stops
                // inventory, runs a full access transaction, then restarts it
                // per tag, which cost a screen using detail mode ~10x its read
                // rate the one time it was wired up here (171/sec -> ~16/sec,
                // same drop the fast/detail profile split further up this file
                // measured). TID stays whatever the inventory round itself
                // carried — null on this reader, always, per that same
                // measurement — and shows through honestly as "—" in the UI.
                val inventoryTid = str { t.getTID() }?.takeIf { it.isNotEmpty() }
                if (inventoryTid != null) tidCount++
                batch.add(
                    mapOf(
                        "epc" to epc,
                        "tid" to inventoryTid,
                        "rssi" to lastRssi,
                        "pc" to num { t.getPC() },
                        "crc" to str { t.getStringCRC() },
                        "antenna" to num { t.getAntennaID().toInt() },
                        "channel" to str { t.getChannel() },
                        "phase" to num { t.getPhase().toInt() },
                        "seenCount" to num { t.getTagSeenCount() },
                    )
                )
            }

            // The whole read event crosses the platform channel as one message.
            // A channel hop per tag was costing an event-loop turn each, so a
            // 50-tag burst woke the Dart isolate 50 times to deliver reads that
            // the UI coalesces into a single frame regardless.
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
