# Box / Slot Fit Implementation Plan

**Goal:** Refuse box sizes and placements that cannot fit a rack slot, and make existing bad data visible.

**Spec:** docs/superpowers/specs/2026-11-26-box-slot-fit-design.md

**Execution:** native, in this session (user: "อนุมัติ ลงมือเลย").

## Global constraints

- Per box: width ≤ slot width ÷ 2, depth ≤ slot depth, height ≤ slot height − 15 cm.
- No slots defined → standard slot 270 × 110 × 140 (max 135 × 110 × 125).
- Missing type size → 60 × 40 × 40. Existing bad data never blocks unrelated saves.

## Review focus

- Unrelated web save while an oversized type already exists → must be accepted.
- Correcting a type's size → its boxes follow.
- Type-size string unparsable or empty → accepted as "no size".
- Several slot sizes → a type is fine if any one fits; a placement is judged on the target slot only.
- Shrinking an empty slot → allowed.

## Tasks

1. `backend/tests/box-fit.test.ts` — failing tests for every row of the spec's check table and the review focus.
2. `backend/src/lib/boxFit.ts` — `maxBoxFor(slot): Size`, `fitsSlot(box, slot): boolean`, `describeMax(slot): string`; `backend/src/services/boxFit.ts` — `slotSizes(db)`, `largestSlotFit(size, slots)`, `refuseOversize(payload, stored, db)` returning `{payload, rejected}` (keys `boxTypeSize`, `boxTooBig`).
3. Wire: `routes/masters.ts` (create/update type, `GET /box-types/size-limit`, resize boxes), `routes/state.ts`, `routes/boxes.ts` (putaway, suggest-location `?tag=`), `services/gate.ts` (gate-in with a shelf), `routes/warehouse3d.ts` (slot resize).
4. Web: size hint and "เกินช่อง" badge in `legacy.html`; clamp and legend in `loc3d.js`; seed sizes in cm.
5. Verify: full backend and frontend suites, demo in browser, correct the demo database.
