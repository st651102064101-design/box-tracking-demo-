---
name: frontend-legacy-ui
description: Edit legacy gate HTML or legacy-sync bridge. Use when changing frontend/public/legacy.html or legacy-sync.js. Not for React-only pages or Three.js internals.
---

# Frontend legacy UI

## Rules of thumb

- Prefer surgical edits to `frontend/public/legacy.html`. Keep parity with the product’s “near-original UI” strategy.
- Persistence bridge lives in `frontend/public/legacy-sync.js` (`boxtrace_p1` ↔ `/api/state`).
- Avoid converting large legacy chunks to React unless the user asked for that migration.

## Verify

Use skill `web-demo-verify` for typecheck/lint when TS wrappers change; for pure HTML/JS, smoke the affected gate flow manually or via existing frontend tests if present.
