package com.abss.smarttrace_pda

object RfidLocatePolicy {
    fun shouldFallback(current: Boolean, locating: Boolean, connected: Boolean,
                       rfidMode: Boolean, receivedTarget: Boolean): Boolean =
        current && locating && connected && rfidMode && !receivedTarget
}
