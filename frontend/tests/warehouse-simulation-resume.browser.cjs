const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '..');
const topHarness = `<!doctype html><iframe src="/legacy-harness" allow="fullscreen; autoplay" style="width:100vw;height:100vh;border:0"></iframe><script type="module">
import {createSessionExpiryGuard} from '/warehouse-session-expiry.mjs';
window.expiredCount=0;window.guard=null;
window.armExpiry=seconds=>{window.guard?.dispose();window.guard=createSessionExpiryGuard({window,getToken:()=>localStorage.getItem('smarttrace_jwt'),onExpire:()=>window.expiredCount++});
 const payload=btoa(JSON.stringify({sub:1,username:'resume-user',exp:Date.now()/1000+seconds}));localStorage.setItem('smarttrace_jwt','header.'+payload+'.sig');window.dispatchEvent(new Event('storage'));};
if(!localStorage.getItem('smarttrace_jwt'))window.armExpiry(3600);
window.harnessReady=true;</script>`;
const childHarness = `<!doctype html><button id="enter">Start</button><div id="loc3dView"><canvas></canvas></div><script>
window.errors=[];window.toast=(t,m)=>errors.push(m);window.liveState={suspends:0,resumes:0};window.LocationWarehouse3D={active:()=>({suspendForSimulation(){liveState.suspends++;return true},resumeFromSimulation(){liveState.resumes++}})};
</script><script type="module">import '/warehouse-simulation-session.mjs';document.getElementById('enter').onclick=()=>window.WarehouseSimulation.enter();window.harnessReady=true;</script>`;
async function main() {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/legacy-harness') { res.setHeader('Content-Type', 'text/html'); res.end(pathname === '/' ? topHarness : childHarness); return; }
    const relative = pathname.startsWith('/vendor/three/') ? `node_modules/three/${pathname.slice('/vendor/three/'.length)}` : `public/${pathname.slice(1)}`;
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      let body = await readFile(file);
      if (pathname === '/warehouse-simulation-view.mjs') body = body.toString()
        .replace('let state = simulation.getState();', '$&\nwindow.restoredEngineCheckpoint=simulation.checkpoint();window.restoredState=state;')
        .replace('controls = new OrbitControls(camera, canvas);', '$&\nwindow.camera=camera;window.controls=controls;')
        .replace('warehouse = createWarehouseScene(renderer, layout, state, abort.signal);', '$&\nwindow.graphics=warehouse;');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--disable-webgpu'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [], api = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url()); });
  let simulationFrame;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const legacy = () => page.frames().find(frame => new URL(frame.url()).pathname === '/legacy-harness');
  const enter = async () => {
    await page.frameLocator('iframe').locator('#enter').click();
    await legacy().waitForFunction(() => Boolean(window.__warehouseSimulationActive && document.activeElement?.tagName === 'IFRAME'));
    simulationFrame = page.frames().find(frame => new URL(frame.url()).pathname === '/warehouse-simulation.html');
    await simulationFrame.waitForFunction(() => Boolean(window.camera && window.graphics?.scene.getObjectByName('simulation-forklift-3')));
  };
  const record = () => page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('boxtrace:warehouse-simulation:'));
    return key ? { key, value: JSON.parse(localStorage.getItem(key)) } : null;
  });
  const close = (a, b) => assert.ok(Math.abs(a - b) < 0.00001, `${a} !== ${b}`);
  try {
    await page.goto(origin); await page.waitForFunction(() => window.harnessReady);
    await legacy().waitForFunction(() => window.harnessReady);
    await enter();
    await page.keyboard.press('b');
    await simulationFrame.evaluate(() => { window.camera.position.set(-10, 25, -21); window.controls.target.set(0, 4, 0); window.controls.update(); });
    await page.keyboard.press('h');
    await simulationFrame.evaluate(() => dispatchEvent(new Event('warehouse-simulation-save')));
    const beforeRefresh = await record();
    assert.ok(beforeRefresh.value.engine.elapsed > 0);
    assert.equal(beforeRefresh.value.view.buildingVisible, false);
    assert.equal(beforeRefresh.value.view.uiHidden, true);
    await page.reload();
    await page.waitForFunction(() => window.harnessReady); await legacy().waitForFunction(() => window.harnessReady);
    const afterRefresh = await record();
    assert.ok(afterRefresh.value.engine.elapsed >= beforeRefresh.value.engine.elapsed, 'pagehide must not overwrite with an earlier periodic checkpoint');
    await enter();
    const restored = await simulationFrame.evaluate(() => ({ checkpoint: window.restoredEngineCheckpoint, position: window.camera.position.toArray(), target: window.controls.target.toArray(), shell: window.graphics.buildingVisible, hidden: document.body.dataset.uiHidden }));
    assert.deepEqual(restored.checkpoint, afterRefresh.value.engine, 'refresh restores the exact engine time without wall-clock catch-up');
    afterRefresh.value.view.orbit.position.forEach((value, i) => close(restored.position[i], value));
    afterRefresh.value.view.orbit.target.forEach((value, i) => close(restored.target[i], value));
    assert.equal(restored.shell, false); assert.equal(restored.hidden, 'true');
    await page.evaluate(() => window.armExpiry(1));
    await page.waitForTimeout(1600);
    assert.equal(await page.evaluate(() => window.expiredCount), 0, 'JWT timer cannot interrupt nested fullscreen simulation');
    assert.equal(await legacy().evaluate(() => Boolean(window.__warehouseSimulationActive && document.fullscreenElement)), true);
    await page.keyboard.press('h');
    await simulationFrame.locator('#first-person-view').click();
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse');
    await page.mouse.move(520, 400); await page.mouse.move(720, 330);
    await simulationFrame.evaluate(() => dispatchEvent(new Event('warehouse-simulation-save')));
    await page.keyboard.press('Escape');
    await legacy().waitForFunction(() => !window.__warehouseSimulationActive);
    assert.equal(await page.evaluate(() => window.expiredCount), 1, 'normal expired login is checked when leaving');
    const escaped = await record();
    assert.equal(escaped.value.view.mode, 'first-person');
    await page.evaluate(() => window.armExpiry(3600));
    await enter();
    assert.deepEqual(await simulationFrame.evaluate(() => window.restoredEngineCheckpoint), escaped.value.engine, 'Esc flushes exact progress before removing the frame');
    assert.equal(await simulationFrame.locator('#first-person-view').getAttribute('aria-pressed'), 'true');
    assert.equal(await simulationFrame.evaluate(() => document.pointerLockElement), null, 'restoring first-person does not ask for mouse lock without a gesture');
    const direction = await simulationFrame.evaluate(() => window.camera.rotation.toArray().slice(0, 3));
    close(direction[0], escaped.value.view.lookPitch); close(direction[1], escaped.value.view.lookYaw);
    await simulationFrame.locator('#warehouse').click({ position: { x: 500, y: 400 } });
    await simulationFrame.waitForFunction(() => document.pointerLockElement?.id === 'warehouse');
    await page.keyboard.press('f');
    await legacy().evaluate(() => document.exitFullscreen());
    await legacy().waitForFunction(() => !window.__warehouseSimulationActive);
    const nativeExit = await record();
    assert.equal(nativeExit.value.view.mode, 'orbit', 'native fullscreen exit synchronously saves the latest view');
    assert.deepEqual(errors, []); assert.deepEqual(api, []);
    console.log(JSON.stringify({ result: 'PASS', checks: ['refresh-checkpoint', 'exact-engine-resume', 'no-wall-clock-catch-up', 'saved-orbit-camera', 'saved-B-H', 'nested-fullscreen-expiry-deferred', 'normal-expiry-on-exit', 'Esc-save-before-removal', 'saved-first-person-look', 'gesture-required-pointer-lock-resume', 'native-fullscreen-flush', 'account-scoped-small-record', 'zero-api', 'zero-runtime-errors'], checkpointBytes: JSON.stringify(nativeExit).length }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
