package com.abss.smarttrace_pda

/**
 * Which RFIDAPI3 transport a handheld may open.
 *
 * TC501's integrated radio is Qualcomm QC_SERIAL. SERVICE_SERIAL, Bluetooth,
 * and USB are not valid fallbacks for that radio. MC3390R and every other
 * reader start on SERVICE_SERIAL and may fall through to a sled or USB.
 */
object RfidTransportPolicy {
    fun isTc501(model: String): Boolean =
        model.contains("TC501", ignoreCase = true)

    fun preferred(model: String): String =
        if (isTc501(model)) "QC_SERIAL" else "SERVICE_SERIAL"

    fun allowsAlternateTransport(model: String): Boolean = !isTc501(model)
}
