package com.abss.smarttrace_pda

import org.junit.Assert.*
import org.junit.Test

class RfidLocatePolicyTest {
    @Test fun `second pull with silent Locate falls back despite successful first pull`() {
        assertFalse(RfidLocatePolicy.shouldFallback(true, true, true, true, true))
        assertTrue(RfidLocatePolicy.shouldFallback(true, true, true, true, false))
    }
    @Test fun `old timer release disconnect and barcode cannot restart antenna`() {
        assertFalse(RfidLocatePolicy.shouldFallback(false, true, true, true, false))
        assertFalse(RfidLocatePolicy.shouldFallback(true, false, true, true, false))
        assertFalse(RfidLocatePolicy.shouldFallback(true, true, false, true, false))
        assertFalse(RfidLocatePolicy.shouldFallback(true, true, true, false, false))
    }
}
