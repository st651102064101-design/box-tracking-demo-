---
name: pda-flutter-change
description: Edit or test SmartTrace PDA Flutter code. Use when changing pda_flutter Dart/UI/tests. Not for backend-only or web-frontend work.
---

# PDA Flutter change

## When to use

- Editing `pda_flutter/lib/**`, `pda_flutter/test/**`, or PDA UI behavior
- Adding/fixing PDA unit tests

## When not to use

- Pure backend API work → use backend docs / other branch harness
- Zebra native RFID / DataWedge deep dives → `pda-device-rfid`
- Shipping an APK → `pda-release-build`

## Workflow

1. Change the smallest surface that satisfies the request.
2. Prefer a **targeted** test under `pda_flutter/test/` for the edited behavior.
3. Run that targeted test. Run the full `flutter test` suite only when the change touches shared controllers, scan pipelines, or multiple screens.
4. Fix failures caused by this change; rerun affected tests.

```bash
cd pda_flutter
flutter test test/<relevant>_test.dart
# optional broader pass:
flutter test
```

## More detail

- Device / RFID specifics: `references/testing.md`
- Outdated notes formerly in `pda_flutter/CLAUDE.md` are superseded by this skill + root `AGENTS.md`.
