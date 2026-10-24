# SDD ledger — plan: docs/superpowers/plans/2026-10-24-warehouse-simulation.md

User approved implementation on 2026-10-24 after confirming two boxes per slot, no DB access, infinite loop. Deployment checkout relocated to D:/Projects/box-tracking-demo-. Existing WEB_APP_DEMO linked checkout repaired and reused; baseline HEAD 24b9115, pre-existing dirty loc3d.js forklift isolation edits must be preserved but excluded from feature commit.

Ruling: execute independent engine and rendering work in parallel with root session integration — approved work split and disjoint files avoid edit conflicts.
Ruling: simulation uses isolated iframe + memory model, preserves mounted real scene — strongest straightforward separation from application state; static scripts and 3D assets are allowed network traffic.
Ruling: initial fixture is exactly five racks and ten boxes, ten boxes fill the bottom shelf only — user confirmed two per slot.

| Scope | Interface/conflict scan | Resolution |
|---|---|---|
| Task 1 | layout and state exports match Task 2 consumption | exact contract in plan |
| Task 2 | start/ready/exit/error messages match Task 3 | exact origin + source validation |
| Task 3 | shared loc3d.js already has old pending changes | baseline copy + stage only own changes |
| Tasks 1/2 | pallet base vs mesh centre | Y is pallet base; local +Z front, cargo 1.55 m forward |
| Task 4 | local deployment on MOBILE_APP_DEMO | deploy files in place; push only isolated WEB_APP_DEMO feature commit |

Status: implementation, independent review, browser checks and Docker deployment complete; ready to push WEB_APP_DEMO.

Verification on 2026-10-24:

- Frontend unit tests: 14 passed, 0 failed (engine 5, lifecycle 9).
- Browser harness: 13 checks passed; two complete engine cycles, exact ten IDs, zero API requests/errors, including nested fullscreen restoration.
- Live Docker smoke test: 8 checks passed using normal login and real warehouse data; no API requests across two polling intervals, live controller/camera/business-data identity restored, first-person pointer lock restored. No baseline or new JavaScript errors.
- Frontend production build and frontend-only Docker rebuild passed. Backend and database containers were not recreated; no seed/migration/putaway was performed.
- Staged loc3d.js syntax and git whitespace checks passed. Staged changes work with both the committed boolean/null queue fields and the user's uncommitted Map/Set changes; old forklift changes remain unstaged.
- Review findings closed: preserve live first-person mode and retry pointer lock on a fresh gesture; pop simulation fullscreen before removing its host so an earlier fullscreen stage survives. Live test additionally found/fixed overly broad refusal when a spectator truck displays previously persisted cargo (not a local in-progress operation).
- Existing dependency warning remains: the project's pinned Next.js 14.2.15 is flagged vulnerable by npm. Dependency upgrades are outside this simulation change.
