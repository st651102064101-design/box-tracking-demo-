---
name: backend-api-change
description: Change Express API routes, services, or Vitest coverage. Use when editing backend/src routes, services, middleware, or tests. Not for Drizzle migration authoring alone.
---

# Backend API change

1. Prefer small route/service edits with Zod validators kept in sync.
2. Add or update tests under `backend/tests` (or colocated patterns already used).
3. Run targeted vitest when possible; full `npm test` when shared middleware/db helpers change.

```bash
cd backend
npm test
npm run typecheck
```

PGlite / disposable fixtures — safe to rerun without approval.
