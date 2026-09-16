# AGENTS.md — WEB_APP_DEMO_THAI_SUBMIT

Slim index for the **Thai submit web/gate** branch (frontend-only tree).
Aligned with [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

## Branch focus

`frontend/` gate UI for Thai submission — including outbound/admin link visibility and gate flows.

## Doc map

| Need | Read |
|------|------|
| Next app | `frontend/app/`, `frontend/package.json` |
| Legacy gate assets | `frontend/public/` |
| Gate UI behavior | skill `gate-ui-change` |
| Verify | skill `frontend-verify` |

## Skills

- `gate-ui-change`
- `frontend-verify`

## Autonomy

Edit `frontend/**`, run frontend npm checks, PR into `WEB_APP_DEMO_THAI_SUBMIT`. Ask before production deploy or force-push.

## Definition of done

UI matches request; relevant frontend checks pass; fix regressions from this change. No PDA/backend requirements on this branch unless those trees appear later.
