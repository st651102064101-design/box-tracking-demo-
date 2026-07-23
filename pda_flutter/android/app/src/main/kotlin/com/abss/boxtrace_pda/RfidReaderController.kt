package com.abss.boxtrace_pda

import android.content.Context
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
    private val exec = Executors.newSingleThreadExecutor()

    private var readers: Readers? = null
    private var reader: RFIDReader? = null
    private var eventHandler: EventHandler? = null
    private var sink: EventChannel.EventSink? = null
    private var maxPower = 270

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

    private fun status(state: String, message: String) =
        emit(mapOf("type" to "status", "state" to state, "message" to message))

    // ── MethodChannel.MethodCallHandler ───────────────────────────────────
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "connect" -> { connect(); result.success(true) }
            "disconnect" -> { disconnect(); result.success(true) }
            "startInventory" -> { startInventory(); result.success(true) }
            "stopInventory" -> { stopInventory(); result.success(true) }
            "setPower" -> { setPower(call.argument<Int>("percent") ?: 100); result.success(true) }
            "isConnected" -> result.success(isConnected())
            else -> result.notImplemented()
        }
    }

    private fun isConnected(): Boolean = reader?.isConnected == true

    // ── connect / configure ───────────────────────────────────────────────
    fun connect() {
        if (isConnected()) {
            status("connected", "เชื่อมต่อแล้ว")
            return
        }
        status("connecting", "กำลังค้นหาเครื่องอ่าน…")
        exec.execute {
            try {
                if (readers == null) readers = Readers(context, ENUM_TRANSPORT.SERVICE_SERIAL)
                readers?.attach(this)

                var list = safeList()
                // MC3390R = SERVICE_SERIAL; fall back to sled / USB like the sample.
                if (list.isEmpty()) { readers?.setTransport(ENUM_TRANSPORT.BLUETOOTH); list = safeList() }
                if (list.isEmpty()) { readers?.setTransport(ENUM_TRANSPORT.SERVICE_USB); list = safeList() }
                if (list.isEmpty()) {
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
                    status("connected", "เชื่อมต่อ ${rd.getHostName()}")
                } else {
                    status("error", "เชื่อมต่อไม่สำเร็จ")
                }
            } catch (e: Exception) {
                Log.e(TAG, "connect failed", e)
                status("error", e.message ?: "เชื่อมต่อไม่สำเร็จ")
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
                reader?.Actions?.Inventory?.perform()
            } catch (e: Exception) {
                Log.w(TAG, "startInventory failed", e)
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
            if (tags != null) {
                for (t in tags) {
                    emit(
                        mapOf(
                            "type" to "tag",
                            "epc" to t.getTagID(),
                            "rssi" to t.getPeakRSSI().toInt(),
                        )
                    )
                }
            }
        }

        override fun eventStatusNotify(e: RfidStatusEvents?) {
            val data = e?.StatusEventData ?: return
            when (data.getStatusEventType()) {
                STATUS_EVENT_TYPE.HANDHELD_TRIGGER_EVENT -> {
                    val evt = data.HandheldTriggerEventData.getHandheldEvent()
                    when (evt) {
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_PRESSED ->
                            emit(mapOf("type" to "trigger", "pressed" to true))
                        HANDHELD_TRIGGER_EVENT_TYPE.HANDHELD_TRIGGER_RELEASED ->
                            emit(mapOf("type" to "trigger", "pressed" to false))
                        else -> {}
                    }
                }
                STATUS_EVENT_TYPE.DISCONNECTION_EVENT -> disconnect()
                else -> {}
            }
        }
    }
}
