# PDA testing notes

## Existing suites (examples)

- `app_controller_test.dart`
- `scan_capture_test.dart`, `rfid_screens_logic_test.dart`
- `location_cascade_test.dart`, `location_entry_policy_test.dart`
- `prefs_pin_offline_test.dart`, `track_screen_grid_test.dart`

Match new tests to the nearest existing file; avoid inventing a parallel harness.

## Defaults

- Local Flutter tests use no production backend and no live Zebra hardware.
- Mock RFID / preference seams already used in the suite; keep that pattern.
- Do not require rebuilding frontend/backend Docker images for a pure Dart unit-test change.
