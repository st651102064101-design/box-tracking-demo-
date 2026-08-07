#!/usr/bin/env bash
# Build (if needed) and install the RFID test app onto an MC3390R over USB.
#
# Waits for a device rather than failing immediately, so it can be started
# before the terminal is plugged in. Refuses anything that isn't an MC33-series
# terminal — installing an RFID app onto whichever phone happened to be on the
# cable is not a mistake worth allowing.
set -euo pipefail
cd "$(dirname "$0")"

APK="app/build/outputs/apk/debug/app-debug.apk"

echo "→ building $APK"
./gradlew --quiet :app:assembleDebug

echo "→ waiting for a device over USB (Ctrl-C to give up)…"
adb wait-for-device

model=$(adb shell getprop ro.product.model | tr -d '\r')
echo "→ found: $model"
case "$model" in
  MC33*) ;;
  *) echo "✗ not an MC33-series terminal ($model) — refusing to install"; exit 1 ;;
esac

adb install -r "$APK"
adb shell monkey -p com.abss.rfidhtml -c android.intent.category.LAUNCHER 1 >/dev/null
echo "✓ installed and launched"
