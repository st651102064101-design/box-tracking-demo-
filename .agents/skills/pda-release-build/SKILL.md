---
name: pda-release-build
description: Build or ship the PDA app. Use when producing APK/IPA, bumping build numbers, or rebuilding the pda Docker service. Not for routine Dart edits.
---

# PDA release / rebuild

## When to use

- `flutter build apk` / `ios` release
- `pubspec.yaml` version / `+build` bumps for device install
- `docker compose` rebuild of the `pda` service when the user asked for a deployable artifact

## When not to use

- Code-only fixes that unit tests can verify → `pda-flutter-change`

## Commands

```bash
cd pda_flutter
flutter build apk --release
# or
flutter build ios --release
```

Compose (only if the user wants container rebuilds):

```bash
docker compose build pda --no-cache && docker compose up -d pda
```

Do **not** rebuild frontend/backend by default for a PDA-only change.

## Done

Artifact builds successfully; version bump committed if installers depend on a new build number.
