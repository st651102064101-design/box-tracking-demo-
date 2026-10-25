# Three-forklift warehouse flow implementation plan

> **For agentic workers:** Use the approved implementation scope below. Independent engine and scene tasks run in parallel; integration, review, verification and deployment run sequentially.

**Goal:** A realistic interior warehouse demonstration with five parallel racks and a continuous 250-box inbound, putaway and outbound cycle.

**Architecture:** Retain the isolated fullscreen session. The pure simulation engine owns stable box identities, vehicle poses and scheduling; the Three.js view consumes snapshots and local static models. The live scene is suspended and restored through the existing session interface.

**Tech Stack:** JavaScript ES modules, Three.js 0.184, Vitest/Node tests, Playwright, existing Next.js/Docker frontend.

**Spec:** The user approved the restated flow and reference layout in this conversation on 2026-10-25 and explicitly requested implementation, Docker rebuild and push to WEB_APP_DEMO.

## Global constraints

- Five parallel rack rows; five shelves, five bays per shelf, two boxes per bay; 50 boxes per rack and 250 per cycle.
- Racks start empty. Only one box may wait on the floor. Inbound delivers a replacement only after the previous box is stored.
- Truck 1 stores in rack/shelf/bay/side order. Truck 3 supplies through Gate In. Truck 2 activates after the first 50 stored boxes and takes FIFO boxes to Gate Out while putaway continues on later racks.
- Do not refill vacated cells within a cycle. Complete all 250 exports before the next cycle.
- Realistic forklift assets matching normal mode. Warehouse interior, visible distinct gates, parallel aisles, blue uprights and orange beams, guards and rack signs.
- Two view controls only; fullscreen, free orbit and first person; Escape restores the prior live scene.
- No business API, storage or DB access from simulation. Static local model/module requests are allowed.
- Preserve unrelated dirty loc3d.js changes. Deploy targeted frontend files to D:/Projects/box-tracking-demo- without touching backend, DB, volumes or existing data. Push only WEB_APP_DEMO.

## Shared interface

`createSimulation()` returns `{ layout, getState, step, dispose, cycleDuration }`.
Layout: `racks` with x/z/width/depth/slotCenters/shelfHeights, floorBounds, one floorPositions entry, staging, gateIn and gateOut. Five rows at x=0, z=-22,-11,0,11,22, width16 depth2. Bounds x=-20..20,z=-35..35. Staging(-12,0,-29), GateIn(-12,0,-35), GateOut(13,0,-35).

Snapshot: `cycle, phase, completedInPhase, storedCount, shippedCount, forklifts, boxes`. Forklifts carry id/role/position/yaw/liftHeight/cargoId/visible/action. Boxes carry stable id/position/rotationY/visible/location (pending/floor/carried/rack/shipped). Forklift local forward is +Z; pallet centre offset1.55 metres. Scene must not synthesize business states.

## Review focus

1. No overlapping vehicles in shared aisles, transitions, staging or gate paths.
2. No new floor box before previous box is stored; no duplicate or missing box ownership.
3. Full-height lift aligns loaded pallet and model forks, including upper shelves.
4. Cancellation while models load releases the temporary session and restores live state.
5. Large elapsed time and repeated cycles remain bounded, deterministic and continuous.

### Task 1: Deterministic flow

Files: public/warehouse-simulation-engine.mjs, tests/warehouse-simulation-engine.test.mjs (under frontend).

- [x] Replace the ten-box specification tests with 250-box ordering, one-floor-box, three independent trucks, activation threshold, occupancy and two-cycle checks.
- [x] Compile independent vehicle tracks and box transitions with aisle reservations and explicit transfer ownership.
- [x] Verify bounded arbitrary-delta advancement, immutable snapshots, disposal, motion and collision checks.
- [x] Run `node --test tests/warehouse-simulation-engine.test.mjs` (5 passed) and `npm test` (19 passed).

### Task 2: Interior and realistic fleet

Files: public/warehouse-simulation-view.mjs, warehouse-simulation.css and focused static helpers if needed.

- [x] Build parallel racks and enclosing warehouse with Gate In/Out, trusses, lights and safety details.
- [x] Load and rig local realistic forklift models; update all three vehicles independently from the agreed state.
- [x] Keep initial/orbit/walking viewpoints inside warehouse; handle model load failure and exit cleanup.
- [x] Visually inspect orbit/first-person plus upper-shelf, outbound and multi-truck snapshots in browser.

### Task 3: Integrate, verify and ship

Files: frontend/tests/warehouse-simulation.browser.cjs, frontend/public/warehouse-simulation.html, docs/warehouse-simulation.md, this plan.

- [x] Update browser cycle assertions to 250 boxes and three forklifts; retain fullscreen, Escape, startup cancellation and zero-API checks.
- [x] Run `npm test` (19 passed), browser harness (18 checks passed) and build (Next.js15.5.28 passed); no browser exceptions.
- [x] Independent review of engine, view and contracts; fix material issues with focused verification.
- [x] Copy only changed simulation files to deployment; rebuild frontend with `docker compose up -d --no-deps --build frontend`.
- [x] Run actual deployed browser smoke check (8 checks passed) and inspect Docker state.
- [ ] Commit scoped files and push WEB_APP_DEMO; record commit and verification.

## Progress and decisions

- Baseline: WEB_APP_DEMO at 2000825d; existing dirty loc3d.js and .simulation-work are preserved.
- Implementation choice: separate left putaway and right outbound lanes plus rack aisle reservations. Exact lane coordinates may be adjusted to fit model clearance without changing the five-row layout.
- Implementation choice: model assets are static local requests; no business API is used.
- User approval already covers implementation, rebuild and push; no additional approval gate is introduced.
- The updated browser specification first failed against the old engine's missing cycleDuration; after integration all 18 checks passed, including model-load cancellation and corrupt-model rollback.
- Scene graphics live in a focused warehouse-simulation-scene.mjs helper. Static geometry and 250 pallet assemblies are instanced; three vehicle rigs share the local GLB geometry and textures.
- Actual normalized GLB body bounds measured approximately x=-0.67..0.67, z=-1.78..0.71; collision tests use the larger envelope x=+-0.7,z=-1.8..0.9 and pass a full cycle.
- The outbound vehicle descends through a designated open overhead transfer bay, avoiding the solid roof. A rack-wide reservation keeps outbound out of each row until putaway finishes and clears that row.
- Independent review found one Important issue: the real mast crossed the front shelf beams although chassis clearance passed. A rendered-model regression failed with -0.2132m clearance for both putaway and outbound. Moving berth centres forward0.30m (rack.z-0.65) yields +0.0868m mast/beam clearance; regression PASS and complete suite19/19 PASS. No other Critical/Important findings.
- Final browser harness18/18 PASS; visual model/clearance checks PASS; Docker frontend build/recreation PASS. Deployed live test8/8 PASS with zero API requests in simulation and zero browser errors. Real controller, camera, boxes, locations and warehouses restored after exit.
- Container file SHA256 hashes match the WEB checkout for all five changed public files. Backend/DB container identities and start timestamps unchanged. Previous deployed simulation files are recoverable from .simulation-work/before-warehouse-flow-20261025.zip.
