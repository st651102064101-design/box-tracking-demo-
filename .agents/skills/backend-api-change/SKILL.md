---
name: backend-api-change
description: Change DB-backed API routes/services on database-postgres. Use when editing backend routes/services/tests without necessarily authoring a new migration.
---

# Backend API change

Keep validators and DB access aligned. Prefer Vitest with PGlite. Touch frontend only if contracts require it.
