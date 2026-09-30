package com.abss.smarttrace_pda

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RfidTransportPolicyTest {
    @Test
    fun tc501StaysOnQcSerial() {
        assertEquals("QC_SERIAL", RfidTransportPolicy.preferred("TC501"))
        assertEquals("QC_SERIAL", RfidTransportPolicy.preferred("zebra tc501"))
        assertTrue(RfidTransportPolicy.isTc501("TC501"))
        assertFalse(RfidTransportPolicy.allowsAlternateTransport("TC501"))
    }

    @Test
    fun tc52AndMc3390rStartOnServiceSerial() {
        assertEquals("SERVICE_SERIAL", RfidTransportPolicy.preferred("TC52"))
        assertEquals("SERVICE_SERIAL", RfidTransportPolicy.preferred("MC3390R"))
        assertFalse(RfidTransportPolicy.isTc501("TC52"))
        assertTrue(RfidTransportPolicy.allowsAlternateTransport("TC52"))
        assertTrue(RfidTransportPolicy.allowsAlternateTransport("MC3390R"))
    }
}
