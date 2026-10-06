# DataWedge checklist

1. Confirm profile name is `SmartTracePDA`.
2. Confirm it is associated with the installed app package (historically `com.abss.boxtrace_pda` / SmartTrace package — verify current `applicationId` in Gradle).
3. After factory reset or DataWedge wipe, reinstall/open the app so profile recreation runs.
4. Reproduce mode switch: RFID selected → imager should not keep soft-triggering; barcode mode → imager on as expected.
5. Prefer fixing profile ensure/bind logic over adding UI workarounds.
