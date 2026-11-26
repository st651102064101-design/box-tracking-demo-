# Gate Systems Implementation Plan

**Spec:** docs/superpowers/specs/2026-11-26-gate-systems-design.md — native execution (user: "อนุมัติ ลงมือเลย").

## Global constraints
- Outbound customer: Excel plan matching the plate, else the gate preset, else leave for review.
- A plan is used once; oldest first; only plans dated today. Unreadable plate while plans wait: review.

## Review focus
- Camera reads before the tags, and after them → same shipment.
- Several boxes on one truck → one plan covers them all.
- Same truck passing again later → plan already used.
- Low-confidence plate → no plan shipment.
- Import row with unknown customer or no plate → reported, others kept.

## Tasks
1. Server: `ship_plans` table, `services/shipPlan.ts`, `routes/ship-plans.ts`, matching in `routes/lpr.ts` and `routes/rfid.ts`; `tests/ship-plans.test.ts`.
2. Web: `systems.js` (gate1, gate2, gate3), `gate-view.js` pure logic, gate page and picker cards in `legacy.html`.
3. Verify, push.
