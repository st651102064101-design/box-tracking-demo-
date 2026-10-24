# Warehouse simulation implementation plan

> For agentic workers: use subagent-driven-development for isolated tasks, with the controller integrating and reviewing. User approved parallel task ownership; do not edit another worker's files.

**Goal:** Add a fullscreen, database-independent warehouse simulation that continuously transfers ten boxes floor → rack 1 → rack 2 → original floor positions, two boxes per slot.

**Architecture:** A dedicated same-origin simulation iframe owns its model, renderer and clock. The real scene remains mounted but suspended. A session controller requests fullscreen directly from a user gesture, activates the isolated scene, and restores the original scene/focus/view on Escape or fullscreen loss. No simulation module uses authentication, API endpoints, localStorage, or live warehouse data.

**Tech stack:** Existing Three.js 0.184 local vendor assets, native ES modules, Node test runner, browser integration tests.

**Spec:** User-approved flow in this conversation, repeated in Global Constraints below.

## Global Constraints

- One forklift, exactly ten unique boxes, five empty racks, each five shelves × five slots, two boxes per slot.
- Each box travels individually. Finish all ten transfers before advancing floor-to-rack1, rack1-to-rack2, rack2-to-floor. Repeat indefinitely; no teleport/reset between cycles.
- Fill slot 1 with two boxes before slot 2; fill all five lower slots before next shelf. Ten boxes occupy the first shelf.
- Start via UI or Shift+S while the 3D view is active. Fullscreen is mandatory. If the browser refuses fullscreen, do not start and show an actionable error in the normal UI.
- Simulation shows only two view controls: orbit/management and first person. Escape from either view exits and restores the real scene. No fixed HUD/badge/table.
- Simulation must not access DB, write API, read API, persist state, or leak IDs into live state. Static local scripts/assets are allowed. Suspend real 3D polling and ignore its realtime events while simulation is active; pause legacy sync through an explicit event/flag.
- Preserve all pre-existing dirty files. Commit only this feature to WEB_APP_DEMO. Rebuild the local frontend Docker service without recreating DB/backend.

## Ownership / Interfaces

### Task 1 — engine (agent A)
Files: `frontend/public/warehouse-simulation-engine.mjs`, `frontend/tests/warehouse-simulation-engine.test.mjs`.
Export `createSimulation()` → `{layout, getState(), step(deltaSeconds), dispose()}`. `step` consumes real seconds, returns current state, must process large elapsed deltas without teleporting in normal small-frame use. Engine has no DOM, Three.js, network, storage or wall clock dependency.
Layout: `{racks:[{id,x,z,width,depth,shelfHeights,slotCenters}], floorPositions:[{x,y,z}], floorBounds:{minX,maxX,minZ,maxZ}}`. `slotCenters` is 5 world-X positions; `shelfHeights` is 5 pallet-base Y elevations. Choose generous side-by-side bays for two pallet footprints and safe lanes.
State: `{phase:'floor-to-rack1'|'rack1-to-rack2'|'rack2-to-floor', completedInPhase:number, cycle:number, action:string, forklift:{position:{x,y,z},yaw:number,liftHeight:number,cargoId:string|null}, boxes:[{id,position:{x,y,z},rotationY:number,location:{kind:'floor'|'rack'|'carried',rack:number|null,shelf:number|null,slot:number|null,side:number|null}}]}`. Coordinates are metres. Box position is pallet base, forklift faces local +Z at yaw 0; carried pallet is centred 1.55 m forward of forklift origin; liftHeight is pallet-base elevation. `getState` returns a detached snapshot.
- [x] Test initial layout/ownership, every phase boundary, slot capacity/order, floor identity restoration and two full loops; test continuous forklift and box displacement, pause/dispose, mutation isolation and large/invalid delta handling before implementation.
- [x] Implement smooth drive/turn/lift/insert/retract actions using aisle waypoints. Avoid rack volumes and staging pallets, including reversing out before lowering a pallet clear of a beam.
- [x] Run `node --test frontend/tests/warehouse-simulation-engine.test.mjs`; record result.

### Task 2 — view (agent B)
Files: `frontend/public/warehouse-simulation.html`, `frontend/public/warehouse-simulation-view.mjs`, `frontend/public/warehouse-simulation.css`.
Consume engine contract above. Draw all layout geometry and ten pallet/box objects once; animate from engine state. Detailed existing forklift GLB may be used if rig can match the 1.55 m carried offset; otherwise build a clear yellow forklift with canopy, wheels, mast, carriage and moving forks. Maintain box pallet-base coordinates exactly.
- [x] Use local Three.js importmap (standard module build); no external CDN; no DB/network except static local assets.
- [x] Render warehouse floor, blue/orange racks, readable in-world rack/channel markings, pallets and forklift with physically clear cargo placement and shadows.
- [x] Only two buttons: orbit and first person; orbit supports rotate/pan/zoom, first-person WASD/arrow movement and mouse look, bounded to warehouse floor. No other fixed UI. Switching views does not reset engine.
- [x] At initialization send `{type:'warehouse-simulation-ready'}` to parent with exact origin. Do not advance until parent message `{type:'warehouse-simulation-start'}` from actual parent + exact origin. Escape posts `{type:'warehouse-simulation-exit'}`. Errors post `{type:'warehouse-simulation-error',message}` and never leave a stuck blank fullscreen view. `pagehide` cancels animation/disposes resources.
- [x] Use visibilitychange to reset frame time (background tab must not race through flow). Preserve orbit view on roundtrip first-person toggle. Root controller verifies browser behavior.

### Task 3 — session/integration (root)
Files: `frontend/public/warehouse-simulation-session.mjs`, `frontend/public/loc3d.js`, `frontend/public/legacy.html`, focused session/browser tests.
- [x] Add simulation entry button to normal 3D toolbar, keyboard shortcut scoped to visible 3D canvas and ignoring editable controls/repeats/modifiers. Session supports an idle real forklift; refuse start during an active real move/load/claim to prevent accidental writes.
- [x] Create fullscreen iframe in preserved parent stage; load can happen after fullscreen request. Engine starts only once fullscreen and child readiness both confirmed. Session exits idempotently on Escape/fullscreen loss/error, pending-start cancellation and repeated entry.
- [x] Add explicit real controller suspend/resume; stop animation and sync, ignore incoming deltas and pending responses. Preserve exact camera/state and reset frame timestamp when resuming. Pause host live sync while active; restore normal operation afterwards.
- [x] Tests: fullscreen rejection, early Esc, stale message/source rejection, enter twice, exit twice, view restoration, no API traffic from child and no simulation data persistence.

### Task 4 — verify, review, deploy
- [x] Independent review of combined feature; fix concrete findings.
- [x] Node engine/session tests and browser checks for the twelve acceptance groups in the conversation; full frontend build.
- [x] Apply only feature changes to D:/Projects/box-tracking-demo- local deployment checkout, preserving pending changes. Rebuild frontend only with `docker compose up -d --no-deps --build frontend`.
- [x] Verify served code and live UI. Stage only feature changes, push WEB_APP_DEMO, report hash and passed/failed checks.

## Review Focus
- Esc while acquiring fullscreen/while pointer locked must restore the scene once; task 3 tests.
- Pending real sync must not remount/overwrite hidden scene; task 3 tests/guards.
- Forklift forks, carried load, shelf elevation must agree through pickup/place; task 1 invariants + task 2 browser review.
- A second cycle has the same ten IDs, no duplicated animation/listener loops; task 1 + task 3 tests.
- Browser refuses fullscreen or WebGL initialization; task 3 failure rollback and view error message.
