package com.abss.smarttrace_pda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class BarcodeScanPolicyTest {
    @Test
    fun heldTriggerDecodesEveryNewBarcodeUntilRelease() {
        val params = BarcodeScanPolicy.params(scannerEnabled = true)
        assertEquals("true", params["scanner_input_enabled"])
        assertEquals(BarcodeScanPolicy.AIM_CONTINUOUS_READ, params["aim_type"])
        assertEquals("0", params["beam_timer"])
        assertEquals("0", params["different_barcode_timeout"])
        assertEquals("500", params["same_barcode_timeout"])
    }

    @Test
    fun disablingTheImagerDoesNotLeaveContinuousAimOn() {
        val params = BarcodeScanPolicy.params(scannerEnabled = false)
        assertEquals("false", params["scanner_input_enabled"])
        assertFalse(params.containsKey("aim_type"))
    }
}
