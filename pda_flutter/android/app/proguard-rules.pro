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
