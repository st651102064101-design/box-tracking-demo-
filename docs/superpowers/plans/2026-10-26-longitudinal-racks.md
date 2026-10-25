# Longitudinal Racks Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align simulation racks with gate traffic, compact their aisles, and provide keyboard-only building/UI visibility controls.

**Architecture:** Explicit rack rotation and one rackPoint(rack, along, height, across) transform define cargo and docking positions. Graphics use corresponding rotated groups. A separate building group owns occluding shell geometry and is toggled by B; H remains overlay-only.

**Tech Stack:** JavaScript modules, Three.js, Node tests, Playwright, Next.js Docker deployment.

**Spec:** docs/superpowers/specs/2026-10-26-longitudinal-racks-design.md

## Global Constraints

- Six racks, 5x5 bays, two pallets per bay, 300 stable identities, five full racks initially.
- Preserve staging and gate positions; no business API/storage access.
- 90-degree rotation, 18cm pair spacers, 5.6m clear aisles.
- Only Orbit / First person buttons; B building, H overlays, no new toggle buttons.
- Preserve unrelated loc3d.js changes; deploy frontend only; push WEB_APP_DEMO.

## Review Focus

- Rotated pallets, beams and actual forklift masts stay aligned on both rack faces.
- Front cross-aisle routes avoid all six racks and other trucks across a complete cycle.
- H and B work independently, including native pointer-lock first-person mode.
- Hidden shell removes overhead occlusion; restoring it constrains orbit inside the building.
- Escape/re-entry restores live state and resets temporary shell visibility.

## Task 1: Layout, docking and routes

- [x] Update engine tests for longitudinal pairs, exact aisle clearance, rotated pallet fit and rack collision rectangles; observe expected failures.
- [x] Add rackPoint transform, rotation metadata, compact pair positions and a front cross-aisle. Update putaway/outbound routes, docking and release rotations.
- [x] Run node --test frontend/tests/warehouse-simulation-engine.test.mjs; require all checks, both cycles and collision sampling to pass.

## Task 2: Graphics and keyboard controls

- [x] Rotate rack graphics using matching local coordinates. Split shell into a toggleable group without combining its static batches with rack/floor batches.
- [x] Remove toggle-ui markup/listener. Add B building toggle and transient help; preserve H. Update rotated pedestrian collision and allow elevated orbit while shell is hidden.
- [x] Update existing browser checks for two buttons, independent B/H toggles, shell restoration, above-roof inspection and first-person operation. Run controls, visual and lifecycle browser checks; inspect rendered captures.

## Task 3: Review, deploy and push

- [x] Update user documentation, review the scoped diff and run affected verification.
- [x] Back up deployment copies, ensure they match prior WEB versions, copy changed public files, rebuild frontend with docker compose up -d --no-deps --build frontend.
- [x] Verify deployed public file bytes, container state and actual app simulation. Commit scoped files and push WEB_APP_DEMO; confirm remote revision.

## Verification and rulings

- Engine: 9 tests passed, including two complete cycles, pallet continuity, signed motion and chassis collision checks. Updated rack rectangles use their real orientation.
- Controls: 30 browser checks passed, including B/H independence under pointer lock, key-repeat guard, above-roof flight, returning indoors, and session reset.
- Lifecycle: 18 browser checks passed, including two 300-box loops, fullscreen/escape restoration and zero API traffic.
- Visual: rotated beam extents confirm 16m longitudinal racks and 5.6m clear aisles; actual GLB mast clearance is 0.066798m on both faces. Hidden shell preserves racks, trucks and gates. Captures inspected.
- Fresh review found overlapping floor signs in the shared aisles; replaced them with one combined sign per aisle. Follow-up review: no remaining findings.
- Ruling: measure aisle clearance from the actual outer beam faces, including the 13cm beam thickness, rather than rack centre lines. Reframed entry camera toward the new rack centre.
- Deployment: production Next.js build passed; frontend recreated. All four changed public resources match the source byte-for-byte over HTTP. Backend and database container identities/start times are unchanged.
- Live app: 12 checks passed, including actual shell toggling with hidden UI, nested fullscreen, native first person and Ctrl, audio startup/cleanup, zero simulation API requests and preservation of the real controller/camera/business data on Escape. No baseline or new runtime errors.
