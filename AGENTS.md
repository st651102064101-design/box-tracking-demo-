# AGENTS.md — database-postgres

Slim index for the **Postgres-oriented** integration branch.
Aligned with [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

## Branch focus

Full stack present, but prioritize **schema, migrations, and DB-backed API** correctness. Frontend/PDA edits only when the task requires them.

## Doc map

| Need | Read |
|------|------|
| Compose / DB service | `docker-compose.yml` |
| Schema | `backend/src/db/schema.ts`, `schema.sql` |
| Migrations | skill `db-schema-migrate` |
| API using DB | skill `backend-api-change` |
| UI only | `frontend/` (no forced schema reading) |

## Skills

- `db-schema-migrate`
- `backend-api-change`

## Autonomy

Local Postgres/PGlite migrate + vitest are disposable — run/fix/rerun freely. PR into `database-postgres`. Ask before production DB ops or destructive migrate on shared environments.

## Definition of done

Schema/API behavior correct, migrations apply cleanly on disposable DB, affected tests green.
