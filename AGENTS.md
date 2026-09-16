# AGENTS.md — MOBILE_APP_DEMO_THAI_SUBMIT

Slim index for the **Thai submit** mobile/PDA line.
Aligned with [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

## Branch focus

PDA + supporting monorepo pieces used for Thai submission demos (Flutter PDA, backend hooks such as FX9600 reader heartbeat, optional `rfid_html_app` / docs). Prefer PDA skills first.

Primary tree: `pda_flutter/`

## Doc map

| Need | Read |
|------|------|
| Product README | `README.md` |
| PDA Flutter | skill `pda-flutter-change` |
| RFID device / DataWedge | skill `pda-device-rfid` |
| Reader online/offline / webhook heartbeat | skill `reader-heartbeat` |
| Backend only | `backend/src/` (no forced full-doc preload) |

## Skills

- `pda-flutter-change`
- `pda-device-rfid`
- `reader-heartbeat`

## Autonomy

Allowed: PDA/backend edits required by the task, local flutter/npm tests, PRs into `MOBILE_APP_DEMO_THAI_SUBMIT`.

Ask before: production secrets, force-push, store release.

## Definition of done

Requested behavior works, relevant tests for touched areas pass, failures from this change fixed. Do not require rebuilding every compose service for a Dart-only fix.
