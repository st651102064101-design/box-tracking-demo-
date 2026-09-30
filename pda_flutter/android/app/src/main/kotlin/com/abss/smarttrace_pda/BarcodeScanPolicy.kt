package com.abss.smarttrace_pda

/**
 * How the physical barcode imager behaves while the operator holds the trigger.
 *
 * DataWedge's default aim type decodes one label and then turns the beam off,
 * so a held trigger on TC52, MC3390R, and TC501 only ever counts the first
 * barcode. Continuous Read keeps decoding every new label for as long as the
 * trigger is held, and stops when it is released. The beam timer is cleared so
 * a long sweep is not cut off. A repeat of the same label is held back briefly
 * so one box sitting in the beam is not counted over and over.
 */
object BarcodeScanPolicy {
    const val AIM_CONTINUOUS_READ = "5"
    const val BEAM_TIMER_UNTIL_RELEASE_MS = "0"
    const val DIFFERENT_BARCODE_TIMEOUT_MS = "0"
    const val SAME_BARCODE_TIMEOUT_MS = "500"

    fun params(scannerEnabled: Boolean): Map<String, String> {
        val values = linkedMapOf(
            "scanner_input_enabled" to if (scannerEnabled) "true" else "false",
        )
        if (!scannerEnabled) return values
        values["aim_type"] = AIM_CONTINUOUS_READ
        values["beam_timer"] = BEAM_TIMER_UNTIL_RELEASE_MS
        values["different_barcode_timeout"] = DIFFERENT_BARCODE_TIMEOUT_MS
        values["same_barcode_timeout"] = SAME_BARCODE_TIMEOUT_MS
        return values
    }
}
