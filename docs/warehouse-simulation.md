# Warehouse simulation

Open Master data → Racks → 3D, then select **โหมดจำลอง**, or press **Shift+S** while the 3D view is visible. Finish any real forklift operation and deselect the vehicle first. Simulation requires browser fullscreen support. Press **Esc** to leave.

The temporary scene is an enclosed industrial warehouse with six racks arranged as three back-to-back pairs and separate Gate In / Gate Out roller shutters. The rack rows run lengthwise along the gate traffic, rotated 90 degrees from their earlier transverse orientation. The clear aisles between the outer beam faces of neighboring pairs are 5.6m wide for two forklifts to pass. Each rack has five shelves with five bays, two pallets per bay: 50 boxes per rack, 300 per cycle. Five racks start full (250 boxes) and rack 1 starts empty. A 1.10m pallet sits centred on a 1.24m-deep shelf, leaving only 5mm at the inside of each beam; paired rear frames have 18cm spacers.

Three realistic forklifts have distinct jobs and start at ground level. The inbound vehicle starts through Gate In immediately and supplies one floor staging position. The putaway vehicle fills rack 1 in bay/side order, lower shelf first. A new staging box is supplied only after the previous box is stored. The outbound vehicle starts immediately, exports the 250 preloaded boxes through Gate Out, then the 50 newly stored boxes after putaway clears rack 1. Vacated cells are not refilled within the same cycle. After all 300 boxes are exported and vehicles return to their start positions, the local scene resets to five full racks and one empty rack and repeats.

Vehicle paths use separate side lanes and reserved rack aisles. Each vehicle has its own pose, cargo and lift state. The scene uses the same local realistic forklift asset as the regular 3D view, with moving forks, wheels and seated operators. Vehicles stay on the floor throughout entry and repeating cycles. Inbound reverses fully through Gate In and disappears between deliveries. Both doors open before a vehicle or load reaches the threshold and close after it clears.

Each forklift has a seated operator wearing a helmet, reflective vest and seat belt, with hands at the steering wheel and feet inside the cabin. The operator stays attached to that chassis and looks toward the reversing side while backing up. The putaway truck approaches the floor pallet straight, reverses clear, then follows a two-metre-radius steering curve into its travel lane. The return curve lines up for the next pickup without stationary spins beside the pallet. The pedestrian markings run separately along the left wall.

**Orbit** supports drag to rotate, right-drag to pan, scroll to zoom, WASD/arrows to move horizontally relative to the view, Space to rise and Shift to descend. **First person** supports WASD/arrows to walk and pointer-locked mouse look without holding a button. Hold **Ctrl** to release the mouse for UI interaction, then release Ctrl to resume the same view. If the browser declines automatic recapture, click the scene. Selecting First person captures the mouse; **F** switches between views. Switching camera modes does not restart the cycle.

**H** hides all control/help overlays; press **H** to show them again. **B** independently hides or restores the walls, roof and overhead building structure, leaving the floor, racks, stock, gates and vehicles visible. With the building hidden, Orbit can rise above the roof for an unobstructed view of the shelves; restoring the building returns the camera inside. Both visibility controls use hotkeys only: the two buttons select Orbit or First person. B works in either view, including with the UI hidden and the mouse captured. Help appears briefly on entry or a view change, then fades after six seconds. **?** recalls it while UI is visible. **Esc** exits the entire simulation, including when the mouse is captured.

Sound is positional for each vehicle: engine startup, continuous idle, shutdown, reverse warning and hydraulic movement. Each roller shutter uses the supplied `door-open-by-freesound-community-royalty-free-music-827701.mp3` for both opening and closing, played at its gate at the original speed. It plays only during gate movement and stops at the motion endpoint. The camera acts as the listener, so nearby vehicles and gates sound louder and their direction follows the view. The hydraulic clip uses exactly seconds 0–1.5 of the original supplied `freesound_community-hydraulics-87154.mp3`. Sound starts when the browser permits playback following user interaction; clicking the scene, selecting a view or pressing a simulation hotkey also enables it. Hiding the tab suspends sound, and exiting stops and releases it. Source filenames, hashes and selected intervals are recorded in `frontend/public/audio/warehouse/manifest.json`. To reproduce the bundled mono WAV assets from the four user-supplied MP3s, run `node scripts/build-warehouse-audio.cjs <source-directory>` from the repository root.

The simulator uses its own isolated model and does not call the business API or write to the database. The live scene remains mounted and paused; its synchronization is suspended until exit. Real box/rack positions are not replaced by the demonstration. When returning to live first-person view, some browsers require one click on the canvas to regain mouse lock after Escape.

Progress is saved in a small, versioned `localStorage` checkpoint, separately for each user or employee account on this browser/origin. It records simulation time/cycle and the camera/view, B and H settings; it contains no token or real inventory. It saves every second and flushes on visibility change, page hide and before removal on Escape or fullscreen exit. Refresh the page and enter simulation again to resume the exact saved point; time does not advance while the page is closed. A restored First person view needs a scene click to recapture the mouse. A corrupt or incompatible checkpoint starts a new scene. If browser storage is blocked or full, the scene keeps running and a brief warning explains that saving is unavailable. Clearing browser site data clears the checkpoint.

The normal login-expiry redirect is deferred while the simulation actually owns fullscreen, including expiry/401 notifications from the nested legacy app. Leaving the simulation saves progress first and then checks the current token again. A newer valid login survives that check; a removed or expired token returns to sign-in. This does not extend a server JWT or weaken API authorization. If a refresh occurs after server expiry, sign in again with the same account and reopen simulation to resume its checkpoint.

## Verification

From `frontend`:

```powershell
npm test
npm run test:security
npm run build
node tests/warehouse-simulation.browser.cjs
node tests/warehouse-simulation-controls.browser.cjs
node tests/warehouse-simulation-resume.browser.cjs
node tests/warehouse-simulation-audio.browser.cjs
node tests/warehouse-simulation.visual.cjs
```

The browser test needs Playwright with Chrome installed; `PLAYWRIGHT_PACKAGE` can point to an existing Playwright installation. It serves a local test harness and checks fullscreen lifecycle, camera controls, two complete 300-box engine cycles, all three vehicle roles, one-box staging, original object restoration, and zero API traffic.

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
