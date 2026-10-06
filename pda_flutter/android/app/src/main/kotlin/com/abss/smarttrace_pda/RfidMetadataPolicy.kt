package com.abss.smarttrace_pda

/** Access reads must never steal a live inventory or barcode trigger. */
object RfidMetadataPolicy {
    fun mayReadTid(connected: Boolean, inventoryRunning: Boolean, rfidMode: Boolean, epc: String): Boolean =
        connected && !inventoryRunning && rfidMode && epc.length % 2 == 0 && epc.matches(Regex("[0-9a-fA-F]{8,256}"))
}
