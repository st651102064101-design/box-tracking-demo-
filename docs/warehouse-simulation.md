# Warehouse simulation

Open Master data → Racks → 3D, then select **โหมดจำลอง**, or press **Shift+S** while the 3D view is visible. Finish any real forklift operation and deselect the vehicle first. Simulation requires browser fullscreen support. Press **Esc** to leave.

The temporary scene is an enclosed industrial warehouse with five parallel rack rows and separate Gate In / Gate Out doors. Each rack has five shelves with five bays, two pallets per bay: 50 boxes per rack, 250 per cycle. All racks start empty.

Three realistic forklifts have distinct jobs. The inbound vehicle supplies one floor staging position through Gate In. The putaway vehicle stores that box, filling both sides of each bay, then the remaining bays, shelves and racks in order. A new staging box is supplied only after the previous box is stored. Once rack 1 contains all 50 boxes, the outbound vehicle activates and exports boxes in original storage order through Gate Out while putaway continues in the later racks. Vacated cells are not refilled within the same cycle. After all 250 boxes are exported and vehicles return to their start positions, the empty-rack cycle repeats.

Vehicle paths use separate side lanes and reserved rack aisles. Each vehicle has its own pose, cargo and lift state. The scene uses the same local realistic forklift asset as the regular 3D view, with moving forks and wheels.

Only two controls appear: **Orbit** (drag to rotate, right-drag to pan, scroll to zoom) and **First person** (WASD/arrows to walk, drag to look). Switching camera modes does not restart the cycle.

The simulator uses its own memory-only model and does not call the business API or persist data. The live scene remains mounted and paused; its synchronization is suspended until exit. Real box/rack positions are not replaced by the demonstration. When returning to live first-person view, some browsers require one click on the canvas to regain mouse lock after Escape.

## Verification

From `frontend`:

```powershell
npm test
npm run test:security
npm run build
node tests/warehouse-simulation.browser.cjs
```

The browser test needs Playwright with Chrome installed; `PLAYWRIGHT_PACKAGE` can point to an existing Playwright installation. It serves a local test harness and checks fullscreen lifecycle, camera controls, two complete 250-box engine cycles, all three vehicle roles, one-box staging, original object restoration, and zero API traffic.

An additional opt-in test exercises an already-running deployment with an existing account:

```powershell
# Supply credentials securely via environment variables; no credentials are stored by the test.
# BOXTRACE_TEST_USERNAME and BOXTRACE_TEST_PASSWORD are required.
# BOXTRACE_TEST_ORIGIN defaults to http://localhost:3000.
node tests/warehouse-simulation.live.cjs
node tests/frontend-upgrade.browser.cjs
```

The live test does not create or relocate boxes. Ordinary navigation may save account UI preferences. It verifies the actual entry button, fullscreen within the app iframe, no API requests during two polling intervals, preservation of the live controller/camera/business data, and live first-person mouse-lock restoration.

The upgrade smoke test covers anonymous redirects, username prefill, compiled styling, forgot-password navigation without sending an OTP, protected API denial and static assets. With the same credentials it also submits the normal login form. The WEB branch additionally checks language switching and the onboarding guard.
