# Warehouse simulation

Open Master data → Racks → 3D, then select **โหมดจำลอง**, or press **Shift+S** while the 3D view is visible. Finish any real forklift operation and deselect the vehicle first. Simulation requires browser fullscreen support. Press **Esc** to leave.

The temporary scene has one forklift, ten floor pallets and five racks. Each rack has five shelves with five bays, two pallets per bay. Ten pallets fill the five bays on the bottom shelf of rack 1, move in the same order to rack 2, then return to their original floor positions. This three-stage cycle repeats continuously.

Only two controls appear: **Orbit** (drag to rotate, right-drag to pan, scroll to zoom) and **First person** (WASD/arrows to walk, drag to look). Switching camera modes does not restart the cycle.

The simulator uses its own memory-only model and does not call the business API or persist data. The live scene remains mounted and paused; its synchronization is suspended until exit. Real box/rack positions are not replaced by the demonstration. When returning to live first-person view, some browsers require one click on the canvas to regain mouse lock after Escape.

## Verification

From `frontend`:

```powershell
npm test
npm run build
node tests/warehouse-simulation.browser.cjs
```

The browser test needs Playwright with Chrome installed; `PLAYWRIGHT_PACKAGE` can point to an existing Playwright installation. It serves a local test harness and checks fullscreen lifecycle, camera controls, two complete engine cycles, original object restoration, and zero API traffic.

An additional opt-in test exercises an already-running deployment with an existing account:

```powershell
# Supply credentials securely via environment variables; no credentials are stored by the test.
# BOXTRACE_TEST_USERNAME and BOXTRACE_TEST_PASSWORD are required.
# BOXTRACE_TEST_ORIGIN defaults to http://localhost:3000.
node tests/warehouse-simulation.live.cjs
```

The live test does not create or relocate boxes. Ordinary navigation may save account UI preferences. It verifies the actual entry button, fullscreen within the app iframe, no API requests during two polling intervals, preservation of the live controller/camera/business data, and live first-person mouse-lock restoration.
