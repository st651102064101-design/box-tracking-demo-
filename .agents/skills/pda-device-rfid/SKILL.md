---
name: pda-device-rfid
description: Zebra RFID/barcode/DataWedge on Thai-submit PDA. Use for scanner modes, device detection, or native RFID controllers. Not for generic copy/UI polish.
---

# PDA device RFID (Thai submit)

- DataWedge profile **SmartTracePDA** must stay bound to the app package.
- Check `RfidReaderController.ensureDataWedgeProfile()` before adding UI workarounds for imager/RFID conflicts.
- Keep TC52 / MC3390R capability detection consistent with existing controller logic.
