# Simulation controls, gates and positional audio implementation plan

> **For agentic workers:** Execute the approved tasks with independent engine, input and audio ownership; integrate and review together. User approved the summarized specification and explicitly said to start.

**Goal:** Immersive mouse-look, keyboard flight, transient controls, animated gate journeys and per-forklift spatial sound in the existing isolated simulation.

**Architecture:** The pure engine supplies vehicle motion and gate openness. The view owns camera/input and composes the graphics and Web Audio modules. Audio assets are bundled static resources and all simulation state stays in memory.

**Tech Stack:** Existing ES modules, Three.js, Web Audio, Pointer Lock, Vitest/Node and Playwright, Next.js/Docker.

**Spec:** User-approved Thai summary in this conversation on 2026-10-25: first-person pointer lock; orbit WASD/Space up/Shift down; F views, H UI toggle, ? transient help, Esc exit; initial truck1 descent; truck3 deliver/reverse through Gate In/disappear; automatic gates; independent reverse/engine/hydraulic positional sounds.

## Constraints and interfaces

- Preserve 250-box deterministic FIFO cycle, one staged box, 50-box outbound activation, rack reservations, live-state restoration and no business API/storage writes.
- Existing `createSimulation()` interface stays compatible. Snapshot forklift gains signed `speed` (m/s along heading), `liftVelocity` (m/s), `engineRunning` (boolean). Negative speed means actual reverse movement. Snapshot `gates` is `{ in: number, out: number }`, openness 0 closed through 1 open.
- Truck1 descends on entry only; subsequent cycle boundaries remain continuous. Truck3 waits hidden completely beyond the Gate In threshold between deliveries.
- Audio module exports `createSimulationAudio({ signal })`, returning `{ ready, resume(), update(state, camera), setPaused(paused), dispose() }`. It lazily creates/unlocks AudioContext from a user gesture, loads only local assets, updates listener from camera and sources by forklift id, and disposes every node/context.
- Root integrates audio into view after input owner finishes. Audio startup failure is nonfatal and offers a brief user gesture hint.
- Inputs: F switch views, H hide/show all overlays, ? show help temporarily, Escape existing exit. Help hides after 6 seconds and respects hidden UI. Orbit translation moves camera and target together. First-person pointer lock catches and handles browser denial without aborting simulation.
- Only scoped WEB_APP_DEMO files committed/pushed. Deployment patches under D:/Projects/box-tracking-demo- retain existing unrelated changes. Rebuild frontend only; DB/backend retain identity.

## Review focus

1. Escape with pointer lock must exit and restore fullscreen/focus/live state; H can restore hidden controls.
2. Gate closes only after vehicle and load clear; truck disappears behind threshold, never on the visible floor.
3. Audio cannot continue after exit, be duplicated on rapid reentry, or depend on real DB state.
4. Reverse/lift/engine playback follows each vehicle independently with camera-distance/direction attenuation.
5. Initial descent versus loop wrap, arbitrary time steps and unchanged box ownership remain coherent.

## Task 1 — engine and gate scheduling

Files: `frontend/public/warehouse-simulation-engine.mjs`, engine tests.
- [x] Add initial putaway descent, hidden inbound offstage departures, explicit gate intervals and signed motion telemetry.
- [x] Verify reverse displacement, gate threshold clearance, intro/loop behavior and complete 250-box cycles.

## Task 2 — input and transient controls

Files: `frontend/public/warehouse-simulation-view.mjs`, `.html`, `.css`, relevant browser test coverage.
- [x] Pointer-lock mouse look; handle unlock and mode changes; keyboard orbit flight.
- [x] Add H toggle/UI button and transient guidance/F/? shortcuts with cleanup.
- [x] Browser check mouse look without drag, keyboard movement, hidden UI recovery and Escape.

## Task 3 — audio preparation and spatial playback

Files: new `frontend/public/warehouse-simulation-audio.mjs`, bundled `audio/warehouse/*`, focused audio tests and asset notes.
- [x] Analyze supplied MP3s, identify startup/steady/shutdown intervals; trim hydraulics exactly 7–9 seconds.
- [x] Per-vehicle panners, reverse loop, seamless idle loop, startup/shutdown and lift playback; unlock/suspend/dispose.
- [x] Verify segment metadata and actual audio transitions/attenuation/cleanup.

## Task 4 — scene integration and delivery

Files: scene helper, view integration, session permissions if needed, browser harness, docs.
- [x] Animate rolling doors from engine gates and provide an unobstructed truck1 overhead entry path.
- [x] Integrate audio and reconcile browser tests with new UI and pointer-lock behavior.
- [x] Run appropriate suite/browser visual and runtime checks; review engine, input and audio integration.
- [x] Rebuild frontend Docker, test deployed page and verify backend/DB unchanged.
- Delivery: commit scoped changes and push WEB_APP_DEMO; record the verified remote hash in the completion response.

## Progress

- Baseline d503cd44. Existing dirty loc3d.js and .simulation-work remain preserved.
- Approved deployment and push authorization persists from this conversation.
- Verification on 2026-10-25: Vitest 29/29; engine 8/8 and audio 7/7 included; browser lifecycle 18 checks, controls 16 checks, real audio 8 checks; visual capture and actual mast/shutter geometry passed. Run fullscreen/Pointer Lock browser tests sequentially: one concurrent run timed out during synthetic unlock, and the isolated rerun passed.
- Local Docker production build succeeded with Next.js 15.5.28. Live app smoke test passed, including nested audio unlock/playback/close, original controller/camera/data restoration, and no business API traffic during simulation. Backend and database container IDs/start times stayed unchanged.
- Review found that autoplay denial can leave `resume()` pending; the entry help now always includes the click-to-enable-sound hint without waiting for promise rejection.
