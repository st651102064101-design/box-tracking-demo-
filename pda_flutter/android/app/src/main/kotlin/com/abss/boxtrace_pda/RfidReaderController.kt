package com.abss.boxtrace_pda

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.ToneGenerator
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.zebra.rfid.api3.*
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors
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
        private const val TAG = "BoxTraceRFID"
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
    //
    // [toneGen]'s volume is fixed at construction (ToneGenerator has no
    // per-call volume knob), so choosing a different volume in Settings
    // means rebuilding it — see [applyBeepStyle]. Guarded by [beepStyleLock]
    // since beepExec's background thread reads it while the main thread
    // (Settings' volume slider) can call applyBeepStyle at any time.
    private val beepStyleLock = Any()
    private val toneGen by lazy { ToneGenerator(AudioManager.STREAM_MUSIC, ToneGenerator.MAX_VOLUME) }
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

    // ── Configurable sound catalog ──────────────────────────────────────────
    //
    // Every "a tag/box was detected" sound in the app funnels through
    // [playSoundId] with one of the ids below. Dart owns the *display* side of
    // this catalog (id -> Thai name, for the settings picker) in
    // rfid_service.dart's kRfidTones; this is the *playback* side, and the
    // two id sets must stay in sync by hand — there's no shared source of
    // truth across the platform channel for something this small.
    //
    // Two playback engines:
    //  - `synth` renders a short raw PCM waveform via AudioTrack. This is what
    //    lets "html_tick" be a genuine, sample-accurate port of the RFID HTML
    //    test page's WebAudio beep (square wave, 2700Hz, the same shaped
    //    envelope) rather than an approximation — ToneGenerator's fixed tones
    //    can't reproduce an arbitrary waveform/frequency. [gain] is a 0-1
    //    volume multiplier baked directly into the waveform's amplitude —
    //    the settings volume slider's contribution, since a synthesized
    //    PCM buffer (unlike ToneGenerator) has no separate playback-volume
    //    knob to turn after the fact.
    //  - The two "classic_*" ids replay ToneGenerator's existing system tones,
    //    kept as options because they're a completely different timbre (the
    //    phone's own DTMF-style tones) and because "classic_ack" is exactly
    //    what every barcode scan sounded like before this feature existed —
    //    picking it back is a no-op change for anyone who liked the old sound.
    //    ToneGenerator's volume is fixed at construction (0-100), so these
    //    two ids route through a throwaway generator built at the current
    //    gain rather than the shared [toneGen], mirroring [previewTone].
    /** Dispatches onto [beepExec] and returns immediately — the entry point
     *  for every external caller (settings preview, Dart's channel-driven ok
     *  tones). [beep] does *not* call this: it is already running inside a
     *  [beepExec] task of its own, and dispatching a second one here would
     *  let that outer task's `finally { beepInFlight = false }` clear the
     *  in-flight flag before the inner, later-queued task actually finishes
     *  playing — defeating the whole point of the flag. It calls
     *  [playSoundIdBlocking] directly instead. */
    private fun playSoundId(id: String, volumePercent: Int) {
        beepExec.execute {
            try {
                playSoundIdBlocking(id, volumePercent)
            } catch (e: Exception) {
                Log.w(TAG, "playSoundId($id) failed", e)
            }
        }
    }

    private fun playSoundIdBlocking(id: String, volumePercent: Int) {
        val gain = (volumePercent.coerceIn(1, 100) / 100.0) * 0.35
        when (id) {
            "none" -> {}
            "classic_beep", "beep" -> classicTone(ToneGenerator.TONE_PROP_BEEP, 40, volumePercent)
            "classic_ack", "ack" -> classicTone(ToneGenerator.TONE_PROP_ACK, 70, volumePercent)
            "click" -> classicTone(ToneGenerator.TONE_PROP_ACK, 40, volumePercent)
            "dtmf" -> classicTone(ToneGenerator.TONE_DTMF_1, 70, volumePercent)
            "ring" -> classicTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 70, volumePercent)
            "html_tick" -> synth(Waveform.SQUARE, 2700.0, 50, gain)
            "soft_tick" -> synth(Waveform.SINE, 1800.0, 45, gain)
            "high_tick" -> synth(Waveform.SQUARE, 3400.0, 35, gain)
            "low_tick" -> synth(Waveform.SQUARE, 900.0, 70, gain)
            "ping" -> synth(Waveform.SINE, 2200.0, 90, gain)
            "double_tick" -> {
                synth(Waveform.SQUARE, 2400.0, 22, gain)
                Thread.sleep(18)
                synth(Waveform.SQUARE, 2400.0, 22, gain)
            }
            else -> Log.w(TAG, "playSoundId: unknown id \"$id\", playing nothing")
        }
    }

    /** A ToneGenerator-backed catalog entry, built fresh at [volumePercent]
     *  since ToneGenerator's loudness is fixed at construction — same
     *  one-shot-generator pattern [playLocateBeep] already uses. */
    private fun classicTone(tone: Int, durationMs: Int, volumePercent: Int) {
        var gen: ToneGenerator? = null
        try {
            gen = ToneGenerator(AudioManager.STREAM_MUSIC, volumePercent.coerceIn(1, 100))
            gen.startTone(tone, durationMs)
        } finally {
            main.postDelayed({ try { gen?.release() } catch (_: Exception) {} }, durationMs + 80L)
        }
    }

    private fun beep() {
        if (!autoBeepEnabled || beepInFlight) return
        beepInFlight = true
        beepExec.execute {
            try {
                playSoundIdBlocking(beepToneId, beepVolume)
            } catch (e: Exception) {
                Log.w(TAG, "beep failed", e)
            } finally {
                beepInFlight = false
            }
        }
    }

    /** Explicit, app-driven tone — "ok" (short tick, a genuinely new tag
     *  landed) or "error" (longer low tone, scan rejected/invalid). Both
     *  fixed/unconfigurable at all times: a barcode-sourced Gate detection
     *  always sounds like this regardless of the operator's RFID tone
     *  choice — only a trigger-pulled RFID detection uses that (see
     *  [playSoundId]/[beepToneId], driven from Dart's addScan via
     *  `viaRfid`), so the two channels stay audibly distinct on purpose. */
    private fun playTone(kind: String) {
        beepExec.execute {
            try {
                if (kind == "error") {
                    synchronized(beepStyleLock) { toneGen.startTone(ToneGenerator.TONE_CDMA_PIP, 220) }
                } else {
                    synchronized(beepStyleLock) { toneGen.startTone(ToneGenerator.TONE_PROP_ACK, 70) }
                }
            } catch (e: Exception) {
                Log.w(TAG, "playTone failed", e)
            }
        }
    }

    /** Which sound [beep]/[playTone]("ok") plays and at what volume, chosen
     *  from Settings and pushed down via [applyBeepStyle] — on connect to
     *  restore the saved choice, and again immediately on every change. */
    @Volatile private var beepToneId = "html_tick"
    @Volatile private var beepVolume = 100

    private fun applyBeepStyle(toneId: String, volumePercent: Int) {
        synchronized(beepStyleLock) {
            beepToneId = toneId
            beepVolume = volumePercent.coerceIn(1, 100)
        }
    }

    /**
     * Plays [toneId] once at [volumePercent] immediately, independent of
     * [beepToneId]/[beepVolume] — the live preview behind Settings' tone
     * picker. Never touches the reader's standing beep style; trying a
     * sound only changes what plays once the operator actually confirms it
     * via [applyBeepStyle].
     */
    private fun previewTone(toneId: String, volumePercent: Int) {
        beepExec.execute {
            try {
                playSoundIdBlocking(toneId, volumePercent)
            } catch (e: Exception) {
                Log.w(TAG, "previewTone failed", e)
            }
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

    /**
     * Proximity beep for the RFID locate/find-box screen: volume AND pitch
     * both track [level] (0..1, same normalized RSSI the on-screen gauge
     * animates against), so a faint return sounds like a faint tick and a
     * strong one sounds loud and sharp — a true Geiger-counter tone, not a
     * fixed click that just repeats faster.
     *
     * A fresh single-shot [ToneGenerator] is used per call rather than the
     * shared [toneGen]: `ToneGenerator`'s volume is fixed at construction,
     * so this is the only way to vary loudness call-to-call. It's disposed
     * immediately after its tone completes — cheap relative to the ~200ms+
     * gap this is throttled to on the Dart side.
     */
    private fun playLocateBeep(level: Double) {
        beepExec.execute {
            var gen: ToneGenerator? = null
            try {
                val clamped = level.coerceIn(0.0, 1.0)
                val volume = (15 + clamped * 85).toInt().coerceIn(1, 100)
                val durationMs = (30 + clamped * 40).toInt()
                val tone = if (clamped > 0.75) ToneGenerator.TONE_PROP_ACK else ToneGenerator.TONE_PROP_BEEP
                gen = ToneGenerator(AudioManager.STREAM_MUSIC, volume)
                gen.startTone(tone, durationMs)
            } catch (e: Exception) {
                Log.w(TAG, "playLocateBeep failed", e)
            } finally {
                main.postDelayed({ try { gen?.release() } catch (_: Exception) {} }, 120)
            }
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
    // How many reads arrived with a TID already attached by the inventory
    // round. That piggyback is now the only source of a TID — the explicit
    // access-read fallback is gone, because it had to stop and restart
    // inventory around every call — so this is what tells "these tags don't
    // report a TID during inventory" apart from "the reader isn't reading".
    private var tidCount = 0L
    // Whether the physical gun trigger is currently held.
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

    // ── Charging state ────────────────────────────────────────────────────
    //
    // The MC3390R firmware refuses *every* inventory command while the battery
    // is charging (RFID_CHARGING_COMMAND_NOT_ALLOWED, see startInventory). On a
    // terminal sitting in its cradle that is indistinguishable from a broken
    // app: the trigger does nothing, the Settings test-fire button does
    // nothing, and the only clue is a one-off error status that never clears
    // itself once the terminal is picked back up.
    //
    // Watching the charger explicitly is what turns that into a state the UI
    // can explain and — more importantly — recover from on its own. Undocking
    // re-runs connect() because the reader has to be re-initialised after the
    // firmware refused commands for the whole charging window; without it the
    // operator has to find the "เชื่อมต่อใหม่" button in Settings by hand,
    // which is exactly the complaint this fixes.
    @Volatile private var charging = false
    private var chargerWatchStarted = false

    private val chargingReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_POWER_CONNECTED -> applyCharging(true)
                Intent.ACTION_POWER_DISCONNECTED -> applyCharging(false)
            }
        }
    }

    private fun applyCharging(nowCharging: Boolean) {
        if (charging == nowCharging) return
        charging = nowCharging
        emit(mapOf("type" to "charging", "charging" to nowCharging))
        if (nowCharging) {
            // Say it before the operator pulls a trigger that cannot work,
            // rather than after — this is the whole point of watching.
            status("error", "อยู่บนแท่นชาร์จ — เครื่องอ่าน RFID ถูกปิดชั่วคราวขณะชาร์จ ถอดออกจากแท่นเพื่อใช้งาน")
        } else {
            status("connecting", "ถอดออกจากแท่นชาร์จแล้ว — กำลังเปิดเครื่องอ่านอีกครั้ง…")
            connect()
        }
    }

    /** Sticky ACTION_BATTERY_CHANGED gives the state at startup, before any transition. */
    private fun readInitialCharging(): Boolean = try {
        val i = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        plugged != 0
    } catch (e: Exception) {
        Log.w(TAG, "readInitialCharging failed", e)
        false
    }

    private fun startWatchingCharger() {
        try {
            context.registerReceiver(
                chargingReceiver,
                IntentFilter().apply {
                    addAction(Intent.ACTION_POWER_CONNECTED)
                    addAction(Intent.ACTION_POWER_DISCONNECTED)
                },
            )
            charging = readInitialCharging()
            emit(mapOf("type" to "charging", "charging" to charging))
        } catch (e: Exception) {
            Log.w(TAG, "startWatchingCharger failed", e)
        }
    }

    // ── MethodChannel.MethodCallHandler ───────────────────────────────────
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "connect" -> { connect(); result.success(true) }
            "disconnect" -> { disconnect(); result.success(true) }
            "startInventory" -> { startInventory(); result.success(true) }
            "stopInventory" -> { stopInventory(); result.success(true) }
            "setPower" -> { setPower(call.argument<Int>("percent") ?: 100); result.success(true) }
            "setPowerIndex" -> { setPowerIndex(call.argument<Int>("index") ?: maxPower); result.success(true) }
            "setAutoBeep" -> { autoBeepEnabled = call.argument<Boolean>("enabled") ?: true; result.success(true) }
            "playTone" -> { playTone(call.argument<String>("kind") ?: "ok"); result.success(true) }
            "playSound" -> {
                playSoundId(call.argument<String>("soundId") ?: "none", call.argument<Int>("volume") ?: 100)
                result.success(true)
            }
            "playLocateBeep" -> { playLocateBeep(call.argument<Double>("level") ?: 0.0); result.success(true) }
            "setBeepStyle" -> {
                applyBeepStyle(call.argument<String>("toneId") ?: "beep", call.argument<Int>("volume") ?: 100)
                result.success(true)
            }
            "previewTone" -> {
                previewTone(call.argument<String>("toneId") ?: "beep", call.argument<Int>("volume") ?: 100)
                result.success(true)
            }
            // setTidEnrichment (from an older branch) intentionally NOT restored —
            // a later commit already on this branch (see PROGRESS.md history)
            // found TID "detail mode" costs ~10x throughput on this reader for a
            // field that never actually arrives that way regardless, and removed
            // the concept end-to-end. Bringing the toggle back would reintroduce
            // exactly that regression.
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
        m["tidCount"] = tidCount
        m["charging"] = charging

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
        // Idempotent, and cheap enough to just call on every connect() rather
        // than needing its own init hook — the app has exactly one path that
        // brings the reader up, so this is where the charger watch belongs.
        if (!chargerWatchStarted) {
            chargerWatchStarted = true
            startWatchingCharger()
        }
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

            applyReadProfile(rd)
        } catch (e: Exception) {
            Log.e(TAG, "configure failed", e)
        }
    }

    /**
     * Puts the reader into its one read profile — fast, full stop. What the
     * terminal does 100% of the time: sweep a pallet and collect EPCs. It
     * matches rfid_html_app's configuration exactly, which is the only
     * configuration measured at full reader speed on this hardware:
     *
     *  - `setAttachTagDataWithReadEvent(false)` — no TagData rides along on the
     *    event; the read loop pulls the EPC and nothing else.
     *  - Tag fields cut to PEAK_RSSI alone. `ALL_TAG_FIELDS` (an "everything"
     *    profile this file used to offer rfid_input_screen so it could show
     *    TID/PC/CRC/antenna/channel/phase per tag) made the reader report
     *    every one of those fields on every round, and measured out to a
     *    10x read-rate drop on this hardware (171/sec -> ~16/sec) for fields
     *    this reader's inventory round never actually carries anyway
     *    ([tidCount] confirms TID specifically never arrives this way) — the
     *    exact stutter that profile existed to show off, not fix. Gone for
     *    good: there is no longer a per-screen toggle for it.
     */
    private fun applyReadProfile(rd: RFIDReader) {
        try {
            rd.Events.setAttachTagDataWithReadEvent(false)
        } catch (e: Exception) {
            Log.w(TAG, "setAttachTagDataWithReadEvent failed", e)
        }
        try {
            val storage = rd.Config.getTagStorageSettings()
            // setTagFields *replaces* the reported set rather than adding to
            // it, so this really is "RSSI only" — EPC is the tag ID itself
            // and always comes back regardless.
            storage.setTagFields(arrayOf(TAG_FIELD.PEAK_RSSI))
            rd.Config.setTagStorageSettings(storage)
        } catch (e: Exception) {
            Log.w(TAG, "tag-field reporting config failed", e)
        }
        try {
            // Off — DPO trades read *rate* for battery, exactly what this
            // profile is not willing to spend.
            rd.Config.setDPOState(DYNAMIC_POWER_OPTIMIZATION.DISABLE)
        } catch (e: Exception) {
            Log.w(TAG, "DPO config failed", e)
        }
        Log.i(TAG, "read profile: fast (EPC+RSSI, DPO off)")
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
        // Answer before the SDK does. The firmware would refuse this anyway
        // (RFID_CHARGING_COMMAND_NOT_ALLOWED below), but only after a round
        // trip that surfaces as "nothing happened" — this is what makes a
        // trigger pull or a Settings test-fire on a cradled terminal say why.
        if (charging) {
            status("error", "อยู่บนแท่นชาร์จ — เครื่องอ่าน RFID ถูกปิดชั่วคราวขณะชาร์จ ถอดออกจากแท่นเพื่อใช้งาน")
            return
        }
        exec.execute {
            try {
                Log.i(TAG, "startInventory: reader=$reader isConnected=${reader?.isConnected}")
                reader?.Actions?.Inventory?.perform()
            } catch (e: Exception) {
                // "already inventorying" is the expected answer to a second
                // start — a held trigger while a screen also calls
                // startInventory(), or two press events for one pull. It is
                // not a failure and must not surface as one.
                if (e is OperationFailureException &&
                    e.getResults() == RFIDResults.RFID_OPERATION_IN_PROGRESS) {
                    Log.d(TAG, "startInventory ignored — inventory already running")
                    return@execute
                }
                Log.w(TAG, "startInventory failed${why(e)}", e)
                // The MC3390R answers RFID_CHARGING_COMMAND_NOT_ALLOWED to
                // every inventory command while the battery is charging, so a
                // terminal sitting in its cradle looks exactly like a broken
                // app. That's a known, actionable hardware state — tell the
                // operator what to actually do about it in Thai, not the raw
                // SDK result code/vendor string (e.g.
                // "rfid_charging_command_not_allowed: charging in progress -
                // command not allowed"), which is what used to reach the
                // screen verbatim.
                if (e is OperationFailureException &&
                    e.getResults() == RFIDResults.RFID_CHARGING_COMMAND_NOT_ALLOWED) {
                    status("error", "อ่าน RFID ไม่ได้ขณะกำลังชาร์จแบตเตอรี่ — ถอดเครื่องออกจากแท่นชาร์จก่อนแล้วลองใหม่")
                } else {
                    status("error", "เริ่มอ่านไม่ได้${why(e)}")
                }
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
            if (chargerWatchStarted) {
                chargerWatchStarted = false
                try {
                    context.unregisterReceiver(chargingReceiver)
                } catch (e: Exception) {
                    Log.w(TAG, "unregisterReceiver failed", e)
                }
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
            val tags: Array<TagData>? = rd.Actions.getReadTags(100)
            if (tags == null || tags.isEmpty()) return

            // Sort by peak RSSI descending so near tags (strongest signal) come first.
            val sortedTags = tags.sortedByDescending { it.getPeakRSSI().toInt() }

            // One tick for the whole event rather than one per tag. At reader
            // speed the difference is inaudible — tones this close together
            // merge anyway — but it keeps the beep from being the thing that
            // paces the read loop.
            beep()

            // Two getters and nothing else, per tag. Any field beyond
            // EPC/RSSI costs a getter call wrapped in its own try/catch on
            // the SDK's read-callback thread — the thread that should be
            // going back for the next batch — and this reader's inventory
            // round never carries a TID regardless (tidCount stays 0; kept
            // in diagnostics as a standing check on that, not because
            // anything still tries to populate it).
            val batch = ArrayList<Map<String, Any?>>(sortedTags.size)
            for (t in sortedTags) {
                tagCount++
                val epc = t.getTagID()
                lastEpc = epc
                lastRssi = t.getPeakRSSI().toInt()
                batch.add(mapOf("epc" to epc, "rssi" to lastRssi))
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
                            // Start inventory right here instead of waiting for
                            // AppController to come back through the
                            // MethodChannel — that round trip (native → Dart
                            // isolate → back to native) was enough added
                            // latency that a quick single-tag point-and-shoot
                            // could release the trigger before Inventory.perform()
                            // ever got called. AppController's own startInventory()
                            // call on the "pressed" event below still arrives
                            // shortly after; it's a harmless redundant call on an
                            // already-running inventory.
                            startInventory()
                            emit(mapOf("type" to "trigger", "pressed" to true))
                        }
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED -> {
                            triggerHeld = false
                            stopInventory()
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
