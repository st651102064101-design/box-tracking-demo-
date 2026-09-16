---
name: db-schema-migrate
description: Create or validate Postgres/Drizzle schema migrations. Use when adding or changing a migration, schema.ts, or schema.sql. Not for ordinary route logic without schema impact.
---

# DB schema migrate

## When

- Editing `backend/src/db/schema.ts` or `schema.sql`
- `drizzle-kit generate` / migrate / push workflows

## Steps

1. Update schema sources.
2. Generate or hand-write migration consistently with existing repo practice.
3. Validate with migrate on disposable DB/PGlite and run related tests.

```bash
cd backend
npm run db:generate   # if used in this branch
npm run db:migrate
npm test
```

Do not apply destructive production migrations unless the user explicitly requested that environment.
