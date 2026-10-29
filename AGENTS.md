# AGENTS.md — WEB_APP_DEMO

Slim project index for coding agents. Read only what the task needs.
Aligned with [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

## Branch focus

**Web / gate UI demo**: Next.js frontend, legacy gate HTML, 3D warehouse view, LPR/gate modes. PDA and backend exist in-tree but are secondary on this branch unless the task says otherwise.

Primary tree: `frontend/`

## Doc map (read only when relevant)

| Need | Read |
|------|------|
| Frontend app / Next routes | `frontend/app/`, `frontend/package.json` |
| Legacy gate UI (near-100% original) | `frontend/public/legacy.html`, `frontend/public/legacy-sync.js` |
| 3D / forklift / WebGL | skill `frontend-3d-gate` |
| Legacy HTML / sync bridge edits | skill `frontend-legacy-ui` |
| Local verify (lint/typecheck/tests) | skill `web-demo-verify` |
| API shape when UI depends on it | `backend/src/routes/` |
| Compose | `docker-compose.yml` |

## Skills

Under `.agents/skills/`:

- `frontend-legacy-ui` — `legacy.html` / `legacy-sync.js` behavior
- `frontend-3d-gate` — Three.js warehouse / forklift / WebGL
- `web-demo-verify` — lint, typecheck, vitest for frontend

## Autonomy

Allowed without per-step approval:

- Edit `frontend/**`
- Run `npm` scripts in `frontend/` (lint, typecheck, test, build)
- Minimal backend touch only when the UI change requires a contract fix
- Commit / push agent branches; open PRs into `WEB_APP_DEMO`

Ask before: force-push, production deploy, secret rotation, merging to `main` unless requested.

## Definition of done

1. UI/behavior matches the request
2. Relevant frontend checks pass (`web-demo-verify`); fix failures from this change
3. Brief note of what was verified

Do not rebuild PDA or force full monorepo test matrices for a frontend-only change.
