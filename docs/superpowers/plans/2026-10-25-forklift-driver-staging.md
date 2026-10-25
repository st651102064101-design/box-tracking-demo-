# Forklift drivers and staging pickup implementation plan

**Goal:** Add a seated operator to all three simulation forklifts and remove circling at the floor-box pickup.

**Approved design:** User approved the summary in this conversation: seated drivers travel with each truck; approach the single floor box and reverse away on a clear, realistic route. Retain the existing simulation flow and deliver by rebuilding Docker and pushing WEB_APP_DEMO.

**Architecture:** The pure simulation engine owns vehicle position and heading. The scene owns the operator geometry attached to each truck, using its existing shared geometry/material lifecycle. Live warehouse data stays separate from the memory-only simulation.

## Tasks

- [x] Trace the staging approach/return headings and reproduce the circling; fix the cause and add regression coverage.
- [x] Measure the existing truck cabin, place a seated operator with helmet, workwear, arms at the steering wheel and feet at the floor; reuse graphics resources.
- [x] Verify actual rendered cabin fit and attachment on all three trucks, route continuity, and the complete 250-box cycle.
- [x] Rebuild the frontend container and check entry/exit in the deployed app.
- Delivery: commit scoped changes and push WEB_APP_DEMO; retain unrelated local changes.

## Constraints

- Three independent forklift roles, one staging box, two boxes per bay, FIFO dispatch and repeating 250-box cycle remain coherent.
- Driver and truck move as a single assembly. No inventory/API writes or new remote model dependency.
- Straight fork insertion/retraction must retain actual reverse-speed telemetry for positional sounds.
- Preserve existing dirty loc3d.js and .simulation-work files.

## Findings and verification

- Root cause: the old 1m lateral/1.3m rearward staging jog caused several stationary 90° pivots in sequence (2160° of cumulative heading changes across the first three deliveries). The regression reproduced a stationary turn beside the pallet before the fix.
- Replace the jog with a straight one-metre reverse clearance and two-metre-radius reversing/forward steering arcs. Curved segment positions and signed speeds share the same analytic trajectory, retaining cargo and sound continuity.
- Each seated operator is attached to its chassis, with eight material batches rather than one draw call per body part. Actual rendered bounds fit within the cabin: boots above .5m, helmet below 2.2m, and anatomy inside its width. Driver origin and head follow chassis translation/rotation independently on all three trucks.
- Independent review found the new left lane overlapped pedestrian markings. Move the markings and rotated floor label to x=-19.85…-18.45, outside both the chassis and full fork sweep.
- Vitest: 30 tests passed, including nine engine checks and two complete 250-box cycles. Browser lifecycle: 18 checks passed. Visual inspection and actual operator/shutter/mast geometry assertions passed without runtime errors or business API calls.
- Docker production build passed. Deployed app checks passed, including all three seated operators, nested fullscreen/audio lifecycle, no simulation API traffic, and restoration of the original controller/camera/data on Escape. Backend and database container IDs/start times stayed unchanged. Final independent review found no outstanding issues after widening clearance for the full fork sweep.
