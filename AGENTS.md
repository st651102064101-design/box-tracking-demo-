# AGENTS.md — MOBILE_APP_DEMO

Slim project index for coding agents (Cursor / Codex). Prefer reading only what the task needs.
Guidance here follows [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra): short skill triggers, contextual docs, clear autonomy, explicit definition of done.

## Branch focus

This branch is the **SmartTrace PDA** demo: Flutter handheld app for Zebra **TC52** / **MC3390R**, RFID + barcode, talking to the BoxTrace / SmartTrace backend.

Primary tree: `pda_flutter/`

## Doc map (read only when relevant)

| Need | Read |
|------|------|
| PDA app overview / stack | `README.md`, `pda_flutter/pubspec.yaml` |
| PDA edit / test / device notes | skill `pda-flutter-change` |
| Zebra RFID, DataWedge, scanner modes | skill `pda-device-rfid` |
| APK / release / rebuild | skill `pda-release-build` |
| Backend API contracts used by PDA | `backend/src/routes/`, `backend/src/validators/` |
| Full-stack compose layout | `docker-compose.yml` |

Do **not** preload every doc for typo-sized or single-file edits.

## Skills

Repo skills live under `.agents/skills/`. Load a skill only when the task matches its description.

- `pda-flutter-change` — Dart/Flutter PDA code or tests
- `pda-device-rfid` — RFID reader, DataWedge profile, device model detection
- `pda-release-build` — APK/iOS release or docker pda service rebuild

## Autonomy (safe without asking each step)

Allowed without per-step approval:

- Edit under `pda_flutter/` (and tightly related backend API stubs if the task requires them)
- Run `flutter test` / targeted tests in `pda_flutter/`
- Local `flutter analyze`, format, and disposable fixture tests
- Commit / push on agent feature branches; open PRs into `MOBILE_APP_DEMO`

Ask before:

- Force-push, rewriting shared history, or merging to `main` / protected branches
- Changing production secrets, JWT keys, or live device fleet config
- Publishing store builds or tagging releases unless the user asked

## Definition of done

Unless the user narrows scope, a code change is **done** when:

1. Implementation matches the request
2. Relevant automated checks for the touched area pass (see skills; do not re-run unrelated full-repo suites by default)
3. Failures caused by the change are fixed and rechecked
4. Brief self-recheck notes what was verified (or states no issues found)

Stop for review earlier only if the user asked for a design/plan-only pass, or a hard blocker needs a decision outside the autonomy list above.
