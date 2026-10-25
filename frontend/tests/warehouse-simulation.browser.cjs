const { createServer } = require('node:http');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const playwright = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '..');
const harness = `<!doctype html><html><body><button id="enter">Start simulation</button><input id="input"><div id="loc3dView"><button id="fullscreen-live">Fullscreen live scene</button><canvas></canvas></div>
<script>window.liveState={boxes:['real-box'],camera:[3,5,7],suspends:0,resumes:0};window.errors=[];window.toast=(t,m)=>errors.push(m);window.LocationWarehouse3D={active:()=>({suspendForSimulation(){liveState.suspends++;return true},resumeFromSimulation(){liveState.resumes++}})};document.getElementById('fullscreen-live').onclick=()=>document.getElementById('loc3dView').requestFullscreen();</script>
<script type="module">import {installSimulationEntry} from '/warehouse-simulation-session.mjs';document.getElementById('enter').onclick=()=>window.WarehouseSimulation.enter();window.harnessReady=true;</script></body></html>`;

async function main() {
  await mkdir(path.join(root, '../.simulation-work'), { recursive: true });
  let apiRequests = 0;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) { apiRequests++; res.writeHead(500); res.end('Unexpected API request'); return; }
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(harness); return; }
    const relative = pathname.startsWith('/vendor/three/') ? `node_modules/three/${pathname.slice('/vendor/three/'.length)}` : `public/${pathname.slice(1)}`;
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readFile(file);
      const type = path.extname(file);
      res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[type] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let page;
  let releaseStartupModule = () => {};
  let releaseModel = () => {};
  try {
    browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      if (window === window.top) window.simulationEventTrace = [];
      const record = event => {
        try {
          window.top.simulationEventTrace?.push({
            event: event.type, key: event.key, message: event.data?.type,
            frame: window === window.top ? 'parent' : 'child',
            fullscreen: document.fullscreenElement?.className || document.fullscreenElement?.id || null,
            focus: document.activeElement?.id || document.activeElement?.tagName,
            time: performance.timeOrigin + performance.now(),
          });
        } catch { /* A detached frame cannot contribute further diagnostics. */ }
      };
      window.addEventListener('keydown', record, true);
      window.addEventListener('message', record, true);
      document.addEventListener('fullscreenchange', record, true);
      document.addEventListener('focusin', record, true);
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.harnessReady);
    await page.locator('#enter').click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    const frame = page.frameLocator('iframe');
    await frame.locator('#orbit-view').waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === 'IFRAME');
    assert.equal(await frame.locator('button:visible').count(), 2);
    assert.equal(await page.evaluate(() => window.__warehouseSimulationActive), true);
    await page.screenshot({ path: path.join(root, '../.simulation-work/simulation-orbit.png') });
    const simulationFrame = page.frames().find(item => item.url().includes('/warehouse-simulation.html'));
    // Exercise the real engine in the browser over every transfer boundary,
    // then sample view controls in the running frame (no production test hook).
    const loop = await simulationFrame.evaluate(async () => {
      const { createSimulation } = await import('/warehouse-simulation-engine.mjs');
      const engine = createSimulation();
      const initial = engine.getState();
      const phases = new Set();
      const roles = new Set();
      let maximumFloor = 0;
      let maximumStored = 0;
      let maximumShipped = 0;
      let state = initial;
      if (!Number.isFinite(engine.cycleDuration)) throw new Error('A finite complete cycle duration is required');
      for (let i = 0; i < 12002 && state.cycle < 2; i++) {
        state = engine.step(engine.cycleDuration / 6000);
        phases.add(state.phase);
        state.forklifts.filter(truck => truck.visible).forEach(truck => roles.add(truck.role));
        maximumFloor = Math.max(maximumFloor, state.boxes.filter(box => box.location.kind === 'floor').length);
        maximumStored = Math.max(maximumStored, state.storedCount);
        maximumShipped = Math.max(maximumShipped, state.shippedCount);
      }
      engine.dispose();
      return { cycle: state.cycle, phases: [...phases], boxes: state.boxes.length, ids: state.boxes.map(b => b.id), initialIds: initial.boxes.map(b => b.id), roles: [...roles].sort(), maximumFloor, maximumStored, maximumShipped };
    });
    assert.equal(loop.cycle, 2); assert.equal(loop.boxes, 250); assert.deepEqual(loop.ids, loop.initialIds);
    assert.deepEqual(loop.roles, ['inbound', 'outbound', 'putaway']);
    assert.equal(loop.maximumFloor, 1); assert.equal(loop.maximumStored, 250); assert.equal(loop.maximumShipped, 250);
    await frame.locator('#first-person-view').click();
    assert.equal(await frame.locator('#first-person-view').getAttribute('aria-pressed'), 'true');
    await frame.locator('#warehouse').click({ position: { x: 400, y: 400 } });
    await page.keyboard.down('w'); await page.waitForTimeout(400); await page.keyboard.up('w');
    await page.screenshot({ path: path.join(root, '../.simulation-work/simulation-first-person.png') });
    await frame.locator('#orbit-view').click();
    assert.equal(await frame.locator('#orbit-view').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__warehouseSimulationActive && !document.fullscreenElement);
    assert.equal(await page.locator('iframe').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.liveState), { boxes: ['real-box'], camera: [3, 5, 7], suspends: 1, resumes: 1 });
    // Editable fields must not trigger the shortcut.
    await page.locator('#input').focus(); await page.keyboard.press('Shift+s');
    assert.equal(await page.locator('iframe').count(), 0);
    await page.locator('#enter').focus(); await page.keyboard.press('Shift+s');
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await page.frameLocator('iframe').locator('#first-person-view').click();
    assert.equal(await page.frameLocator('iframe').locator('#first-person-view').getAttribute('aria-pressed'), 'true', 'Reentry camera button is interactive before Escape');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__warehouseSimulationActive);
    assert.equal(await page.evaluate(() => window.liveState.resumes), 2);
    // Entering from an already-fullscreen live scene must not strand an iframe
    // in that scene's fullscreen stack or replace its preserved live objects.
    await page.locator('#fullscreen-live').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'loc3dView');
    await page.evaluate(() => {
      window.beforeNestedSimulation = {
        view: document.getElementById('loc3dView'),
        canvas: document.querySelector('#loc3dView > canvas'),
        state: window.liveState,
        boxes: window.liveState.boxes,
        camera: window.liveState.camera,
        fetch: window.fetch,
        focus: document.activeElement,
      };
    });
    await page.keyboard.press('Shift+s');
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains('warehouse-simulation-host'));
    await page.frameLocator('iframe').locator('#orbit-view').waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === 'IFRAME');
    assert.equal(await page.locator('#loc3dView > .warehouse-simulation-host > iframe').count(), 1);
    assert.equal(await page.evaluate(() => window.__warehouseSimulationActive), true);
    assert.deepEqual(await page.evaluate(() => [window.liveState.suspends, window.liveState.resumes]), [3, 2]);
    await page.frameLocator('iframe').locator('#first-person-view').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__warehouseSimulationActive && !document.querySelector('.warehouse-simulation-host'));
    assert.equal(await page.locator('iframe').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.liveState), { boxes: ['real-box'], camera: [3, 5, 7], suspends: 3, resumes: 3 });
    assert.equal(await page.evaluate(() => {
      const before = window.beforeNestedSimulation;
      return document.getElementById('loc3dView') === before.view
        && document.querySelector('#loc3dView > canvas') === before.canvas
        && window.liveState === before.state
        && window.liveState.boxes === before.boxes
        && window.liveState.camera === before.camera
        && window.fetch === before.fetch
        && document.activeElement === before.focus;
    }), true);
    const restoredFullscreen = await page.evaluate(() => document.fullscreenElement?.id || null);
    assert.equal(restoredFullscreen, 'loc3dView', 'Exiting simulation restores the live scene fullscreen state');
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
    // HTML can paint before its module installs input handlers. Holding that
    // real request reproduces a fast click/Escape during iframe startup.
    const startupModuleGate = new Promise(resolve => { releaseStartupModule = resolve; });
    await page.route('**/warehouse-simulation-view.mjs', async route => {
      await startupModuleGate;
      await route.continue().catch(() => {}); // The cancelled frame may be gone.
    });
    await page.locator('#enter').click();
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains('warehouse-simulation-host'));
    const pendingViewButton = page.frameLocator('iframe').locator('#first-person-view');
    await pendingViewButton.waitFor();
    const pendingViewBounds = await pendingViewButton.boundingBox();
    await page.mouse.click(pendingViewBounds.x + pendingViewBounds.width / 2, pendingViewBounds.y + pendingViewBounds.height / 2);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__warehouseSimulationActive, null, { timeout: 5000 });
    assert.equal(await page.locator('iframe').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.liveState), { boxes: ['real-box'], camera: [3, 5, 7], suspends: 4, resumes: 4 });
    releaseStartupModule();
    await page.unroute('**/warehouse-simulation-view.mjs');
    // Realistic model startup is asynchronous too. Escape must cancel safely
    // before its response, without a delayed ready event reopening the scene.
    const modelGate = new Promise(resolve => { releaseModel = resolve; });
    let modelRequested = false;
    await page.route('**/models/forklift-wheels.glb', async route => {
      modelRequested = true;
      await modelGate;
      await route.continue().catch(() => {});
    });
    const pendingModelRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/models/forklift-wheels.glb');
    await page.locator('#enter').click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await pendingModelRequest;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__warehouseSimulationActive);
    assert.deepEqual(await page.evaluate(() => window.liveState), { boxes: ['real-box'], camera: [3, 5, 7], suspends: 5, resumes: 5 });
    releaseModel();
    await page.unroute('**/models/forklift-wheels.glb');
    assert.equal(modelRequested, true, 'The test cancelled an actual pending realistic-model load');
    assert.deepEqual(await page.evaluate(() => window.errors), []);
    // A corrupt local model must report failure and restore the live scene,
    // rather than leaving an inert fullscreen canvas indefinitely.
    await page.route('**/models/forklift-wheels.glb', route => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: 'invalid model' }));
    await page.locator('#enter').click();
    await page.waitForFunction(() => !window.__warehouseSimulationActive && window.errors.length === 1);
    assert.equal(await page.locator('iframe').count(), 0);
    assert.equal(await page.evaluate(() => document.fullscreenElement), null);
    assert.deepEqual(await page.evaluate(() => window.liveState), { boxes: ['real-box'], camera: [3, 5, 7], suspends: 6, resumes: 6 });
    await page.unroute('**/models/forklift-wheels.glb');
    assert.equal(apiRequests, 0);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.errors.length), 1, 'Only the deliberately corrupt model produces a user-visible error');
    const { ids, initialIds, ...loopSummary } = loop;
    console.log(JSON.stringify({ result: 'PASS', checks: ['fullscreen', 'only-two-buttons', 'two-250-box-loops', 'three-independent-roles', 'single-floor-staging', 'first-person-movement', 'view-toggle', 'Esc-restore', 'shortcut-editable-guard', 'shortcut-reentry', 'already-fullscreen-entry', 'already-fullscreen-Esc-cleanup', 'live-object-fetch-focus-restoration', 'Esc-during-module-startup', 'Esc-during-model-load', 'corrupt-model-rolls-back', 'zero-api-requests', 'zero-browser-errors'], restoredFullscreen, apiRequests, loop: loopSummary }));
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(JSON.stringify({ diagnostics: await page.evaluate(() => ({ active: window.__warehouseSimulationActive, fullscreen: document.fullscreenElement?.className || document.fullscreenElement?.id || null, liveState: window.liveState, events: window.simulationEventTrace?.slice(-100) })) }));
    }
    throw error;
  } finally { releaseStartupModule(); releaseModel(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
