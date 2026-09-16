---
name: frontend-verify
description: Lint, typecheck, or test the Thai-submit frontend. Use when verifying frontend changes. Not required for every one-line copy tweak.
---

# Frontend verify

```bash
cd frontend
npm run typecheck
npm run lint
npm test
```

Run the subset matching the change. Rerun failures caused by the change without asking each step.
