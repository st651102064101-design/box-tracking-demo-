# rfidapi3lib's ProtocolQC class talks to the Qualcomm QRS RFID service
# (com.qti.qrs.*) when a device happens to use that stack — hence the AAR's
# own manifest already marks it optional: <uses-library ... required="false"/>.
# The classes themselves live in a separate Qualcomm-provided library that
# isn't (and shouldn't be) bundled here; R8 just needs telling that's expected,
# or it fails the whole release build over classes we deliberately don't ship.
# Full list confirmed from R8's own missing_rules.txt output for this AAR.
-dontwarn com.qti.qrs.**

# Emitted by an annotation-processing-only dependency (google errorprone);
# javax.lang.model is compiler/tooling API, never present or needed at runtime.
-dontwarn javax.lang.model.**

# rfidapi3lib picks its transport implementation (serial/Bluetooth/USB) at
# runtime via Class.newInstance() reflection, not a normal `new`. R8 has no
# way to see that call site names a real class, so with no explicit keep it
# freely renames/strips those transport classes — which doesn't fail the
# build, it just makes the reflective lookup blow up at runtime with
# "InstantiationException: java.lang.Class<U0.z> cannot be instantiated"
# (seen on-device the SDK's own obfuscated internal classes, not just its
# public com.zebra.rfid.api3 surface). Keep the whole SDK, name and all.
-keep class com.zebra.** { *; }
-keep class vendor.zebra.** { *; }
-keepclassmembers class com.zebra.** { *; }

# Keeping the SDK whole (above) makes R8 also chase its optional, unused
# features — SFTP firmware push (jsch), the ZIOTC HTTP/WebSocket bridge
# (nanohttpd, java_websocket), and an alternate XML parser (xerces) — none of
# which we bundle because we don't use fixed-reader firmware-over-SFTP or
# ZIOTC. Same shape as the qti.qrs rule above: tell R8 these are optional.
-dontwarn com.jcraft.jsch.**
-dontwarn fi.iki.elonen.**
-dontwarn org.apache.xerces.**
-dontwarn org.java_websocket.**
