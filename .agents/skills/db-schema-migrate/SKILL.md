---
name: db-schema-migrate
description: Create or validate Postgres/Drizzle migrations on database-postgres. Use when adding or changing migrations or schema files. Not for UI-only tasks.
---

# DB schema migrate

Update `schema.ts` / `schema.sql`, generate or author migrations consistently, migrate on disposable Postgres/PGlite, run related Vitest.

```bash
cd backend
npm run db:migrate
npm test
```
