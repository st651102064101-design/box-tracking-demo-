# AGENTS.md — BACKEND

Slim index for the **API-only** `BACKEND` branch.
Aligned with [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

## Branch focus

Express + TypeScript + Drizzle + PostgreSQL/PGlite. This worktree is essentially `backend/` only.

## Doc map (read only when relevant)

| Need | Read |
|------|------|
| App bootstrap / middleware | `backend/src/app.ts`, `backend/src/index.ts` |
| Routes | `backend/src/routes/` |
| Schema / SQL | `backend/src/db/schema.ts`, `backend/src/db/schema.sql` |
| Validators | `backend/src/validators/` |
| Adding/changing migrations | skill `db-schema-migrate` |
| API feature + tests | skill `backend-api-change` |

## Skills

- `backend-api-change` — routes, services, vitest
- `db-schema-migrate` — Drizzle/SQL schema or migrate scripts

## Autonomy

Allowed: edit `backend/**`, run `npm test` / `typecheck` / migrate against local or PGlite fixtures, commit/push agent branches, PR into `BACKEND`.

Ask before: production DB changes, secret rotation, force-push.

## Definition of done

Implementation + affected Vitest cases green + failures from this change fixed. Do not invent frontend/PDA work on this branch.
