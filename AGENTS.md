# AGENTS.md — main

Slim full-stack index for `main`. Contextual reading only.
Aligned with [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

## Branch focus

Integration trunk: `frontend/` + `backend/` + `pda_flutter/`. Prefer the skill that matches the touched surface; do not load every skill.

## Doc map

| Need | Read |
|------|------|
| Product overview | `PROGRESS.md`, compose files |
| Frontend UI / 3D | skill `frontend-change` |
| API / DB | skill `backend-change` |
| PDA Flutter | skill `pda-change` |

Demo-specific deep playbooks also live on `WEB_APP_DEMO`, `BACKEND`, and `MOBILE_APP_DEMO` — prefer those branches for product-line work when possible.

## Skills

- `frontend-change`
- `backend-change`
- `pda-change`

## Autonomy

Safe: local installs, lint/typecheck/tests for touched packages, docker compose for disposable local stacks, agent feature branches + PRs into `main` when asked.

Ask before: production deploy, force-push, secret changes.

## Definition of done

Code complete for the request, affected package checks green, failures from the change fixed. Stop early only for plan-only requests or out-of-scope decisions.
