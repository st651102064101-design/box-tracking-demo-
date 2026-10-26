// Opt-in smoke test against an existing deployment. Uses a normal test login;
// never seeds data or performs putaway. Navigation can save normal UI prefs.
const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const origin = process.env.BOXTRACE_TEST_ORIGIN || 'http://localhost:3000';
const username = process.env.BOXTRACE_TEST_USERNAME;
const password = process.env.BOXTRACE_TEST_PASSWORD;
const output = path.resolve(__dirname, '../../.simulation-work');

async function main() {
  assert.ok(username && password, 'Set BOXTRACE_TEST_USERNAME and BOXTRACE_TEST_PASSWORD for an existing account');
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, 'Normal test login must succeed');
  const auth = await response.json();
  assert.ok(auth.token, 'Login returned a token');
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--disable-webgpu'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [], apiDuringSimulation = [];
  let collecting = false;
  // Observe the real graphics instance without adding a hook to shipped code.
  await page.route('**/warehouse-simulation-view.mjs', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('warehouse = createWarehouseScene(renderer, layout, state, abort.signal);', '$&\nwindow.__observedWarehouseGraphics = warehouse; window.__observedWarehouseLayout = layout; window.__observedInitialState = state; window.__restoredCheckpoint = simulation.checkpoint();');
    await route.fulfill({ response, body });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (collecting && new URL(request.url()).pathname.startsWith('/api/')) apiDuringSimulation.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  try {
    await page.addInitScript(({ token }) => {
      localStorage.setItem('boxtrace_jwt', token);
      localStorage.setItem('smarttrace_jwt', token);
      if (window === window.top) window.__simulationAudioEvidence = [];
      const NativeAudioContext = window.AudioContext;
      if (NativeAudioContext && location.pathname === '/warehouse-simulation.html') {
        window.AudioContext = class extends NativeAudioContext {
          constructor(...args) {
            super(...args);
            const record = { context: this, sources: [] };
            window.top.__simulationAudioEvidence.push(record);
            const createSource = this.createBufferSource.bind(this);
            this.createBufferSource = () => {
              const source = createSource(); record.sources.push(source); return source;
            };
          }
        };
      }
    }, { token: auth.token });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const live = page.frameLocator('iframe[title="BoxTrace"],iframe[title="SmartTrace"]');
    await live.locator('#nav [data-tab="setup"]').click({ timeout: 60000 });
    await live.locator('[data-stab="loc"]').click();
    await live.locator('[data-lview="3d"]').click();
    const liveFrame = page.frames().find(frame => new URL(frame.url()).pathname === '/legacy.html');
    assert.ok(liveFrame, 'Actual legacy app frame exists');
    await liveFrame.waitForFunction(() => window.LocationWarehouse3D?.active?.() && !window._loc3dRendering, null, { timeout: 90000 });
    await live.locator('.loc3d-loading').waitFor({ state: 'detached' });
    console.log('Live 3D scene loaded');
    await liveFrame.evaluate(() => {
      window.__testBeforeSimulation = {
        controller: window.LocationWarehouse3D.active(),
        view: window.LocationWarehouse3D.active().getView(),
        data: JSON.stringify({ boxes: S.boxes, locations: S.locations, warehouses: S.warehouses }),
      };
    });
    const baselineErrors = [...errors]; errors.length = 0;
    await live.locator('.loc3d-toolbar button').filter({ hasText: 'โหมดจำลอง' }).click();
    console.log(JSON.stringify(await liveFrame.evaluate(() => ({ active: window.__warehouseSimulationActive, toast: [...document.querySelectorAll('.toast')].map(el => el.textContent) }))));
    const sim = live.frameLocator('.warehouse-simulation-host iframe');
    await sim.locator('#orbit-view').waitFor();
    await liveFrame.waitForFunction(() => document.fullscreenElement?.classList.contains('warehouse-simulation-host'));
    assert.equal(await sim.locator('.view-controls button:visible').count(), 2);
    const simulationFrame = page.frames().find(frame => new URL(frame.url()).pathname === '/warehouse-simulation.html');
    await simulationFrame.waitForFunction(() => Boolean(window.__observedWarehouseGraphics?.scene.getObjectByName('simulation-forklift-3')), null, { timeout: 30000 });
    const operators = await simulationFrame.evaluate(() => [1, 2, 3].map(index => {
      const truck = window.__observedWarehouseGraphics.scene.getObjectByName(`simulation-forklift-${index}`);
      return Boolean(truck && truck.getObjectByName('ForkliftOperator')?.parent === truck);
    }));
    assert.deepEqual(operators, [true, true, true], 'The deployed scene renders a seated driver on every truck');
    assert.deepEqual(await simulationFrame.evaluate(() => ({
      racks: window.__observedWarehouseLayout.racks.length,
      facing: window.__observedWarehouseLayout.racks.map(rack => rack.facing),
      longitudinal: window.__observedWarehouseLayout.racks.every(rack => Math.abs(rack.rotationY + Math.PI / 2) < 0.000001),
      stock: window.__observedInitialState.boxes.filter(box => box.location.kind === 'rack').length,
      ground: window.__observedInitialState.forklifts.every(truck => truck.position.y === 0),
    })), { racks: 6, facing: [1, -1, 1, -1, 1, -1], longitudinal: true, stock: 250, ground: true });
    collecting = true;
    await page.waitForTimeout(8500); // covers at least two normal four-second sync polls
    assert.deepEqual(apiDuringSimulation, []);
    await page.screenshot({ path: path.join(output, 'simulation-docker.png') });
    await page.keyboard.press('b');
    assert.equal(await simulationFrame.evaluate(() => window.__observedWarehouseGraphics.scene.getObjectByName('simulation-building-shell').visible), false, 'Deployed B hides the actual building shell');
    await page.keyboard.press('h');
    assert.equal(await sim.locator('button:visible').count(), 0, 'Deployed H hides the two view controls');
    await page.keyboard.press('b');
    assert.equal(await simulationFrame.evaluate(() => window.__observedWarehouseGraphics.buildingVisible), true, 'Deployed B still works with the UI hidden');
    assert.equal(await sim.locator('button:visible').count(), 0, 'Building toggle does not restore UI');
    await page.keyboard.press('b');
    await page.screenshot({ path: path.join(output, 'simulation-docker-open-building.png') });
    await page.keyboard.press('h');
    await sim.locator('#first-person-view').click();
    assert.equal(await sim.locator('#first-person-view').getAttribute('aria-pressed'), 'true');
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse');
    await page.keyboard.down('ControlLeft');
    await simulationFrame.waitForFunction(() => !document.pointerLockElement && document.getElementById('warehouse').dataset.cursor === 'ui');
    assert.equal(await liveFrame.evaluate(() => Boolean(window.__warehouseSimulationActive && document.fullscreenElement)), true, 'Ctrl cursor retains nested app fullscreen');
    await page.keyboard.up('ControlLeft');
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse', null, { timeout: 2000 }).catch(async () => { await sim.locator('#warehouse').click(); });
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse');
    await page.waitForFunction(() => window.__simulationAudioEvidence.some(record => record.context.state === 'running' && record.sources.some(source => source.buffer)), null, { timeout: 25000 });
    assert.equal(await page.evaluate(() => window.__simulationAudioEvidence.length), 1, 'Nested simulation unlocks one real audio context');
    collecting = false;
    await page.keyboard.press('Escape');
    await liveFrame.waitForFunction(() => !window.__warehouseSimulationActive);
    await page.waitForFunction(() => window.__simulationAudioEvidence.every(record => record.context.state === 'closed'));
    const profile = new URLSearchParams(new URL(simulationFrame.url()).hash.slice(1)).get('profile');
    const checkpointKey = `boxtrace:warehouse-simulation:${encodeURIComponent(profile)}`;
    const savedAfterExit = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), checkpointKey);
    assert.ok(savedAfterExit?.engine?.elapsed > 0, 'The deployed scene saves real progress on exit');
    assert.equal(await liveFrame.evaluate(() => {
      const prior = window.__testBeforeSimulation, controller = window.LocationWarehouse3D.active();
      return controller === prior.controller
        && controller.getView().position.distanceTo(prior.view.position) < 0.0001
        && JSON.stringify({ boxes: S.boxes, locations: S.locations, warehouses: S.warehouses }) === prior.data;
    }), true, 'Real controller, camera and business data restored');
    // Regression: enter from live first-person and retain mouse look on return.
    await live.locator('.loc3d-first-person').click();
    await liveFrame.waitForFunction(() => Boolean(document.pointerLockElement));
    await page.keyboard.press('Shift+s');
    await sim.locator('#orbit-view').waitFor();
    const secondSimulationFrame = page.frames().find(frame => new URL(frame.url()).pathname === '/warehouse-simulation.html');
    await secondSimulationFrame.waitForFunction(() => Boolean(window.__restoredCheckpoint));
    assert.deepEqual(await secondSimulationFrame.evaluate(() => window.__restoredCheckpoint), savedAfterExit.engine, 'Deployed re-entry restores the exact saved engine position');
    await sim.locator('#first-person-view').click();
    await page.keyboard.press('Escape');
    await liveFrame.waitForFunction(() => !window.__warehouseSimulationActive);
    assert.equal(await live.locator('.loc3d-first-person').getAttribute('aria-pressed'), 'true');
    if (!await liveFrame.evaluate(() => Boolean(document.pointerLockElement))) {
      // Native Escape can require a fresh gesture. The first click only locks
      // the pointer; it must not select a real pallet or change the camera mode.
      await live.locator('#loc3dView canvas').click({ position: { x: 20, y: 20 } });
      await liveFrame.waitForFunction(() => Boolean(document.pointerLockElement));
    }
    assert.equal(await live.locator('.loc3d-first-person').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    const savedBeforeRefresh = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), checkpointKey);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await live.locator('#nav [data-tab="setup"]').click({ timeout: 60000 });
    await live.locator('[data-stab="loc"]').click();
    await live.locator('[data-lview="3d"]').click();
    const refreshedLive = page.frames().find(frame => new URL(frame.url()).pathname === '/legacy.html');
    await refreshedLive.waitForFunction(() => window.LocationWarehouse3D?.active?.() && !window._loc3dRendering, null, { timeout: 90000 });
    await live.locator('.loc3d-loading').waitFor({ state: 'detached' });
    await live.locator('.loc3d-toolbar button').filter({ hasText: 'โหมดจำลอง' }).click();
    await sim.locator('#orbit-view').waitFor();
    const resumedFrame = page.frames().find(frame => new URL(frame.url()).pathname === '/warehouse-simulation.html');
    await resumedFrame.waitForFunction(() => Boolean(window.__restoredCheckpoint));
    assert.deepEqual(await resumedFrame.evaluate(() => window.__restoredCheckpoint), savedBeforeRefresh.engine, 'Full app refresh preserves simulation progress');
    collecting = true;
    // Alter only this disposable browser's token expiry. No server account or
    // database change is needed to exercise the deployed login timers.
    await page.evaluate(() => {
      const prior = localStorage.getItem('boxtrace_jwt') || localStorage.getItem('smarttrace_jwt');
      const segments = prior.split('.');
      const payload = JSON.parse(atob(segments[1].replace(/-/g, '+').replace(/_/g, '/')));
      payload.exp = Math.floor(Date.now() / 1000) - 1;
      segments[1] = btoa(JSON.stringify(payload));
      for (const key of ['boxtrace_jwt', 'smarttrace_jwt']) localStorage.setItem(key, segments.join('.'));
      dispatchEvent(new Event('storage'));
    });
    await refreshedLive.evaluate(() => dispatchEvent(new Event('storage')));
    await refreshedLive.evaluate(() => window.handleSessionExpired());
    await page.waitForTimeout(1200);
    assert.equal(new URL(page.url()).pathname, '/', 'Expired login cannot interrupt the deployed fullscreen simulation');
    assert.equal(await refreshedLive.evaluate(() => Boolean(window.__warehouseSimulationActive && document.fullscreenElement)), true);
    assert.deepEqual(apiDuringSimulation, []);
    collecting = false;
    await page.keyboard.press('Escape');
    await page.waitForURL(url => url.pathname === '/login', { timeout: 15000 });
    assert.ok(await page.evaluate(key => Boolean(JSON.parse(localStorage.getItem(key))?.engine), checkpointKey), 'Checkpoint survives deferred login navigation');
    assert.deepEqual(errors, [], 'No new runtime errors in simulation or return to real scene');
    console.log(JSON.stringify({ result: 'PASS', checks: ['deployed-entry-button', 'nested-app-fullscreen', 'deployed-seated-operators', 'longitudinal-paired-preloaded-ground-scene', 'two-view-buttons-only', 'B-H-independent-deployed-shell', 'no-api-over-two-polls', 'first-person-control', 'Ctrl-cursor-retains-fullscreen', 'Esc-real-controller-camera-data-restore', 'live-first-person-resume', 'deployed-checkpoint-reentry', 'full-app-refresh-resume', 'expired-login-and-401-deferred', 'checkpoint-before-login-exit', 'zero-new-runtime-errors'], apiDuringSimulation, baselineErrors }));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'simulation-live-failure.png'), timeout: 10000 }).catch(() => {});
    console.error(JSON.stringify({ liveUrl: page.url(), errors, apiDuringSimulation }));
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
