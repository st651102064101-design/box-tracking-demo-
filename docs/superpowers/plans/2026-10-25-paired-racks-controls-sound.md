# Paired warehouse racks, immediate operation and sound

> **For agentic workers:** Use executing-plans for the engine/scene and independent workers for audio and controls. Steps use checkbox syntax.

**Goal:** Apply the user's approved rack, startup, Ctrl cursor and audio changes to the isolated simulator.

**Architecture:** Keep the deterministic memory-only timeline, instanced scene, pointer-lock controller and positional Web Audio ownership. Pair six racks into three back-to-back rows; start five racks full and one empty. Incoming supply fills the empty rack while outbound exports the preloaded inventory followed by newly stored loads, then resets the local cycle.

**Tech Stack:** Three.js, native browser input/Web Audio, JavaScript modules, existing Node/Playwright checks.

**Spec:** User-approved summary in this conversation: paired backs; pallets fit depth; every rack except one full; immediate ground-level trucks; hold Ctrl for cursor; matching shutter sound; original hydraulic clip 0–1.5 seconds.

## Global Constraints

- No business API, storage or database writes from simulation.
- Preserve dirty loc3d.js and unrelated deployment/backend/mobile edits.
- Rebuild frontend Docker and push only scoped WEB_APP_DEMO changes.
- Six racks, five shelves, five bays, two pallets per bay; 250 preloaded, 50 inbound.

## Review Focus

- Both front-facing directions must dock without mast/rack collision or box snapping.
- Prefilled stock must ship before newer inbound stock and repeat without identity drift.
- Trucks stay on the floor, including loop boundaries; only one staging load.
- Ctrl unlock must preserve fullscreen and not be treated as Escape.
- Shutters and hydraulics must stop sounding when stationary/paused/disposed.

### Task 1: Engine and paired scene (root)

- [x] Update engine invariants for six paired racks, 250 preloaded boxes, zero descent, FIFO dispatch and both approach directions; observe old implementation fail.
- [x] Change layout/berths/timeline; render both rack faces, fitted pallet depth and closed roof.
- [x] Run engine suite, inspect actual GLB mast clearances on both sides and scene captures.

### Task 2: Positional shutter and revised hydraulics (audio worker)

- [x] Trim original hydraulics 0–1.5 seconds; generate local metallic roller shutter assets.
- [x] Bind separate gate panners to layout positions and motion, retaining disposal/pause behavior.
- [x] Run relevant audio checks.

### Task 3: Ctrl cursor (controls worker)

- [x] Track intentional Ctrl unlock separately from Escape and focus loss; resume pointer lock on release/click.
- [x] Update transient instructions and exercise actual browser lifecycle.

### Task 4: Integration/deployment (root)

- [x] Update guide and existing browser expectations, run necessary combined checks and independent review.
- [x] Copy scoped assets to D: deployment with hash guards; rebuild frontend Docker and check live application.
- Delivery: commit/push WEB_APP_DEMO and verify the remote revision.

## Verification outcome

- Frontend suite: 4 files, 31 tests passed.
- Engine: two complete 300-box cycles, FIFO, occupancy, continuous poses and collision checks.
- Actual GLB mast clearance: 0.066798m at putaway and both outbound faces.
- Controls: 25 real browser checks; audio: 8 unit checks and 12 browser checks, including positional attenuation.
- Lifecycle browser checks: 18 passed, zero business API calls and browser errors.
- Independent review: mirrored rack signs corrected; no remaining actionable findings.
- Frontend Docker production build and live nested-app checks passed, including Ctrl/Fullscreen and original data restoration. All 10 served public assets byte-match WEB sources.
