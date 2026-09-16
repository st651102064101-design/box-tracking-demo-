---
name: pda-device-rfid
description: Zebra PDA RFID/barcode and DataWedge work. Use when changing scanner modes, device detection (TC52/MC3390R), or native RFID controllers. Not for generic Flutter UI polish.
---

# PDA device · RFID · DataWedge

## When to use

- RFID read loops, trigger behavior, Gen2 / inventory settings
- Barcode vs RFID mode switching
- Detecting TC52 vs MC3390R (or related capability flags)
- Android/Kotlin reader controller or DataWedge profile binding

## When not to use

- Pure Dart widget layout with no scanner impact → `pda-flutter-change`
- APK packaging only → `pda-release-build`

## Key facts

- App auto-creates DataWedge profile **SmartTracePDA** and binds it to the app package. Without that binding, the device falls back to Profile0 and runtime enable/disable of the barcode imager may not stick.
- Implementation entry: `pda_flutter/android/.../RfidReaderController.kt` (`ensureDataWedgeProfile()`).
- Package / profile mismatches cause “barcode still beeps in RFID mode” class bugs — check profile binding on-device before rewriting Dart.

## Progressive detail

- Profile + debug checklist: `references/datawedge.md`
