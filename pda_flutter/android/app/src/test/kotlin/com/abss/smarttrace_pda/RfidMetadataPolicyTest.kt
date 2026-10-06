package com.abss.smarttrace_pda

import org.junit.Assert.*
import org.junit.Test

class RfidMetadataPolicyTest {
    @Test fun `TID cannot steal RFID inventory or barcode even for a valid EPC`() {
        assertFalse(RfidMetadataPolicy.mayReadTid(true, true, true, "ABCD1234"))
        assertFalse(RfidMetadataPolicy.mayReadTid(true, false, false, "ABCD1234"))
        assertFalse(RfidMetadataPolicy.mayReadTid(false, false, true, "ABCD1234"))
        assertTrue(RfidMetadataPolicy.mayReadTid(true, false, true, "ABCD1234"))
    }
    @Test fun `malformed odd length and empty EPC never cause SDK access`() {
        for (epc in listOf("", "BOX-001", "ABCDE1234", "ABCX1234", "ABCD1234\n"))
            assertFalse(RfidMetadataPolicy.mayReadTid(true, false, true, epc))
    }
}
