// Real browser controls coverage. Camera observation is injected only by this
// test server; the shipped view exposes no test-specific state or methods.
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '..');
const harness = `<!doctype html><html><body><button id="enter">Start simulation</button><div id="loc3dView"><canvas></canvas></div>
<script>window.liveState={suspends:0,resumes:0};window.errors=[];window.toast=(t,m)=>errors.push(m);window.LocationWarehouse3D={active:()=>({suspendForSimulation(){liveState.suspends++;return true},resumeFromSimulation(){liveState.resumes++}})};</script>
<script type="module">import '/warehouse-simulation-session.mjs';document.getElementById('enter').onclick=()=>window.WarehouseSimulation.enter();window.harnessReady=true;</script></body></html>`;

async function main() {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(harness); return; }
    const relative = pathname.startsWith('/vendor/three/') ? `node_modules/three/${pathname.slice('/vendor/three/'.length)}` : `public/${pathname.slice(1)}`;
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      let body = await readFile(file);
      if (pathname === '/warehouse-simulation-view.mjs') {
        body = body.toString().replace('controls = new OrbitControls(camera, canvas);', '$&\nwindow.observedCamera = camera; window.observedControls = controls; window.observedFrames = 0;')
          .replace('function animate(time) {', '$&\nwindow.observedFrames++;');
      }
      res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let simulationFrame;
  const snapshot = () => simulationFrame.evaluate(() => ({ position: window.observedCamera.position.toArray(), target: window.observedControls.target.toArray(), rotation: window.observedCamera.rotation.toArray().slice(0, 3) }));
  const enter = async () => {
    await page.locator('#enter').click();
    await page.waitForFunction(() => document.activeElement?.tagName === 'IFRAME');
    simulationFrame = page.frames().find(item => item.url().includes('/warehouse-simulation.html'));
    await simulationFrame.waitForFunction(() => Boolean(window.observedCamera));
  };
  const pressFor = async key => {
    const frames = await simulationFrame.evaluate(() => window.observedFrames);
    await page.keyboard.down(key);
    await simulationFrame.waitForFunction(before => window.observedFrames >= before + 6, frames, { timeout: 10000 });
    await page.keyboard.up(key);
  };
  const closeTo = (a, b, message) => assert.ok(Math.abs(a - b) < 0.001, `${message}: ${a} vs ${b}`);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.harnessReady);
    await enter();
    const orbit = await snapshot();
    await simulationFrame.locator('#first-person-view').click();
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse', null, { timeout: 5000 });
    const initialLook = await snapshot();
    await page.mouse.move(1100, 500);
    await page.mouse.move(1900, 550);
    const looked = await snapshot();
    assert.ok(Math.abs(looked.rotation[1] - initialLook.rotation[1]) > 0.1, 'Pointer-locked mouse movement looks around without dragging or stopping at the viewport edge');
    await page.keyboard.press('f');
    await simulationFrame.waitForFunction(() => !document.pointerLockElement);
    assert.equal(await page.evaluate(() => window.__warehouseSimulationActive), true, 'An intentional orbit unlock must keep the simulation active');
    const restoredOrbit = await snapshot();
    orbit.position.forEach((value, axis) => closeTo(restoredOrbit.position[axis], value, 'Returning to orbit restores its saved camera'));
    orbit.target.forEach((value, axis) => closeTo(restoredOrbit.target[axis], value, 'Returning to orbit restores its saved target'));

    // Face east so the expected horizontal movement is independent of the
    // implementation's default yaw and catches fixed-world-axis movement.
    await simulationFrame.evaluate(() => {
      window.observedCamera.position.set(-10, 5, -25);
      window.observedControls.target.set(0, 5, -25);
      window.observedControls.update();
    });
    const beforeFlight = await snapshot();
    await pressFor('w');
    const afterFlight = await snapshot();
    assert.ok(afterFlight.position[0] > beforeFlight.position[0] + 0.3, `Orbit W flies in the horizontal viewing direction: ${JSON.stringify({ beforeFlight, afterFlight })}`);
    closeTo(afterFlight.position[2], beforeFlight.position[2], 'Orbit W does not use a fixed world heading');
    [0, 1, 2].forEach(axis => closeTo(afterFlight.position[axis] - beforeFlight.position[axis], afterFlight.target[axis] - beforeFlight.target[axis], 'Orbit flight translates camera and target together'));
    await pressFor('Space');
    const raised = await snapshot();
    assert.ok(raised.position[1] > afterFlight.position[1] + 0.3, 'Space raises the orbit camera');
    closeTo(raised.position[1] - afterFlight.position[1], raised.target[1] - afterFlight.target[1], 'Vertical flight moves the target too');
    await pressFor('Shift');
    const lowered = await snapshot();
    assert.ok(lowered.position[1] < raised.position[1] - 0.3, 'Shift lowers the orbit camera');

    await page.keyboard.press('h');
    assert.equal(await simulationFrame.locator('button:visible').count(), 0, 'H hides every control, including its own restore button');
    await page.keyboard.press('?');
    assert.equal(await simulationFrame.locator('#controls-help').isVisible(), false, 'Help respects hidden UI');
    await page.keyboard.press('f');
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse');
    assert.equal(await simulationFrame.locator('#controls-help').isVisible(), false, 'Mode hints respect hidden UI');
    await page.keyboard.press('f');
    await page.keyboard.press('h');
    assert.equal(await simulationFrame.locator('button:visible').count(), 3, 'H restores all controls');
    await simulationFrame.locator('#toggle-ui').click();
    assert.equal(await simulationFrame.locator('button:visible').count(), 0, 'The UI button hides itself too');
    await page.keyboard.press('h');
    await page.keyboard.press('?');
    assert.equal(await simulationFrame.locator('#controls-help').isVisible(), true, '? displays controls help');
    await simulationFrame.locator('#controls-help').waitFor({ state: 'hidden', timeout: 7000 });

    await page.keyboard.press('f');
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__warehouseSimulationActive && !document.fullscreenElement);
    assert.deepEqual(await page.evaluate(() => window.liveState), { suspends: 1, resumes: 1 }, 'Escape from locked first person restores the live scene');

    await enter();
    await simulationFrame.locator('#first-person-view').click();
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse');
    // The browser can consume Escape itself: exercise the resulting native
    // unlock event with no keydown delivered to the application.
    await simulationFrame.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => !window.__warehouseSimulationActive);
    assert.deepEqual(await page.evaluate(() => window.liveState), { suspends: 2, resumes: 2 }, 'Pointer-lock loss without a keydown exits and restores the live scene');

    await enter();
    await simulationFrame.locator('#first-person-view').click();
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse');
    await simulationFrame.evaluate(() => { window.dispatchEvent(new Event('blur')); document.exitPointerLock(); });
    await simulationFrame.waitForFunction(() => !document.pointerLockElement);
    assert.equal(await page.evaluate(() => window.__warehouseSimulationActive), true, 'Window blur is not mistaken for Escape');
    await simulationFrame.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.keyboard.press('f');
    await simulationFrame.evaluate(() => { HTMLElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('Pointer lock refused', 'NotAllowedError')); });
    await page.keyboard.press('f');
    await simulationFrame.waitForFunction(() => !document.getElementById('controls-help').hidden && /click|mouse/i.test(document.getElementById('controls-help').textContent));
    assert.equal(await page.evaluate(() => window.__warehouseSimulationActive), true, 'Pointer-lock refusal offers guidance without failing the session');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__warehouseSimulationActive);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.errors), []);
    console.log(JSON.stringify({ result: 'PASS', checks: ['native-pointer-lock', 'unbounded-mouse-look', 'F-mode-switch', 'intentional-unlock', 'orbit-snapshot', 'view-relative-orbit-flight', 'Space-Shift-height', 'H-all-overlays', 'UI-button-hide', 'hidden-mode-help', 'transient-help', 'locked-Escape', 'swallowed-Escape', 'blur-unlock', 'lock-refusal', 'zero-browser-errors'] }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
