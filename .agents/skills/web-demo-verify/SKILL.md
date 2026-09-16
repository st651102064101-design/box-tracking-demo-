---
name: web-demo-verify
description: Run frontend lint, typecheck, or vitest. Use when verifying WEB_APP_DEMO frontend changes. Not a mandate to run every check on every typo.
---

# Web demo verify

```bash
cd frontend
npm run typecheck
npm run lint
npm test
```

Run the subset that matches the change. Full `npm test` when shared gate/3D helpers move; skip PDA `flutter test` and backend vitest unless those trees were edited.

Local fixtures are disposable; rerun failed checks caused by the change without asking each time.
