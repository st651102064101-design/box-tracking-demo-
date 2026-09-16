---
name: pda-flutter-change
description: Edit Thai-submit PDA Flutter code or tests. Use when changing pda_flutter Dart/UI/tests. Not for reader-heartbeat webhook-only work.
---

# PDA Flutter change (Thai submit)

Prefer targeted `flutter test` under `pda_flutter/test/`. Full suite when shared controllers/scan pipelines change.

```bash
cd pda_flutter
flutter test test/<relevant>_test.dart
```

Branch target: `MOBILE_APP_DEMO_THAI_SUBMIT` (not a legacy `pda` branch name).
