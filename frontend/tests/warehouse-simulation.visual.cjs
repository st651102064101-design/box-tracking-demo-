// Static visual QA: render actual view/modules at deterministic engine times.
// The wrapper is served only by this local test server, never shipped as a hook.
const { createServer } = require('node:http');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '..');

async function main() {
  const { createSimulation } = await import(pathToFileURL(path.join(root, 'public/warehouse-simulation-engine.mjs')));
  const engine = createSimulation();
  const samples = [];
  for (let time = 0; time < engine.cycleDuration; time += 1) {
    const state = engine.step(1);
    if (samples.length === 0 && state.boxes.some(box => box.location.kind === 'floor')) samples.push({ name: 'staging', time: time + 1 });
    if (samples.length === 1 && state.storedCount === 50) samples.push({ name: 'rack-full', time: time + 1 });
    if (samples.length === 2 && state.storedCount >= 100 && state.shippedCount > 0) {
      samples.push({ name: 'working', time: time + 1 });
      break;
    }
  }
  engine.dispose();
  assert.equal(samples.length, 3, 'The actual engine reaches staging, full rack and parallel dispatch');
  const clearanceEngine = createSimulation();
  const dockingStates = [];
  for (let time = 0; time < clearanceEngine.cycleDuration && dockingStates.length < 2; time += 0.1) {
    const state = clearanceEngine.step(0.1);
    if (dockingStates.length === 0 && state.storedCount === 50 && state.forklifts[0].action === 'place') {
      dockingStates.push({ state, truckIndex: 0, rackIndex: 0 });
    } else if (dockingStates.length === 1 && state.forklifts[1].cargoId === 'simulation-box-050' && state.forklifts[1].action === 'pickup') {
      dockingStates.push({ state, truckIndex: 1, rackIndex: 0 });
    }
  }
  clearanceEngine.dispose();
  assert.equal(dockingStates.length, 2, 'Both vehicles reach the upper-shelf docking poses');
  let snapshotTime = 0, gateView = false;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) { res.writeHead(500); res.end('Business API forbidden'); return; }
    const relative = pathname.startsWith('/vendor/three/') ? `node_modules/three/${pathname.slice('/vendor/three/'.length)}` : `public/${pathname.slice(1)}`;
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      let body = await readFile(file);
      if (pathname === '/warehouse-simulation-engine.mjs') {
        body = body.toString().replace('export function createSimulation(', 'function createSimulationForCapture(')
          + `\nexport function createSimulation() { const engine = createSimulationForCapture(); engine.step(${snapshotTime}); return { ...engine, step() { return engine.getState(); } }; }\n`;
      }
      if (pathname === '/warehouse-simulation-view.mjs' && gateView) {
        body = body.toString().replace('camera.position.set(-18, 10, -34);', 'camera.position.set(-18, 5, -24);')
          .replace('controls.target.set(0, 1, -16);', 'controls.target.set(-12, 2, -35);');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--disable-webgpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], forbidden = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) forbidden.push(request.url()); });
  await page.addInitScript(() => {
    window.visualReady = false;
    window.visualError = null;
    addEventListener('message', event => {
      if (event.data?.type === 'warehouse-simulation-ready') {
        window.visualReady = true;
        window.postMessage({ type: 'warehouse-simulation-start' }, location.origin);
      }
      if (event.data?.type === 'warehouse-simulation-error') window.visualError = event.data.message;
    });
  });
  const output = path.join(root, '../.simulation-work');
  await mkdir(output, { recursive: true });
  try {
    // Real dynamic shutters must retract above the vehicle and the incoming
    // vehicle must disappear only after reversing all the way beyond Gate In.
    const gateEngine = createSimulation();
    const gateSamples = [];
    let sawInbound = false;
    for (let time = 0; time < 150; time += 0.25) {
      const state = gateEngine.step(0.25);
      const truck = state.forklifts[2];
      if (!gateSamples.length && state.gates?.in === 1 && truck.position.z > -35 && truck.speed > 0) {
        gateSamples.push({ name: 'gate-in-open', time: time + 0.25 });
        sawInbound = true;
      }
      if (sawInbound && !truck.visible && state.gates?.in === 0) {
        gateSamples.push({ name: 'gate-in-closed', time: time + 0.25 });
        break;
      }
    }
    gateEngine.dispose();
    assert.equal(gateSamples.length, 2, 'Inbound opens, clears the portal, disappears and closes the gate');
    for (const sample of gateSamples) {
      snapshotTime = sample.time; gateView = true;
      await page.goto(`${origin}/warehouse-simulation.html`);
      await page.waitForFunction(() => window.visualReady || window.visualError, null, { timeout: 30000 });
      assert.equal(await page.evaluate(() => window.visualError), null);
      await page.screenshot({ path: path.join(output, `warehouse-${sample.name}.png`) });
    }
    gateView = false;
    for (const sample of samples) {
      snapshotTime = sample.time;
      await page.goto(`${origin}/warehouse-simulation.html`);
      await page.waitForFunction(() => window.visualReady || window.visualError, null, { timeout: 30000 });
      assert.equal(await page.evaluate(() => window.visualError), null);
      await page.screenshot({ path: path.join(output, `warehouse-${sample.name}.png`) });
    }
    await page.locator('#first-person-view').click();
    await page.screenshot({ path: path.join(output, 'warehouse-first-person.png') });
    const rigBounds = await page.evaluate(async (dockingStates) => {
      const THREE = await import('three');
      const { createSimulation } = await import('/warehouse-simulation-engine.mjs');
      const { createWarehouseScene } = await import('/warehouse-simulation-scene.mjs');
      const model = createSimulation();
      const state = model.getState();
      const graphics = createWarehouseScene({ capabilities: { getMaxAnisotropy: () => 1 } }, model.layout, state, new AbortController().signal);
      await graphics.ready;
      const truck = graphics.scene.getObjectByName(state.forklifts[0].id);
      truck.position.set(0, 0, 0); truck.rotation.set(0, 0, 0); truck.updateMatrixWorld(true);
      const body = new THREE.Box3().setFromObject(truck.getObjectByName('ForkliftBodyTrim'));
      const forks = new THREE.Box3().setFromObject(truck.getObjectByName('ForkliftMastInner'));
      const wheels = [];
      truck.traverse(node => { if (/^Wheel_(FL|FR|RL|RR)$/.test(node.name)) wheels.push(node.userData.wheelRadius); });
      const result = { body: { min: body.min.toArray(), max: body.max.toArray() }, forks: { min: forks.min.toArray(), max: forks.max.toArray() }, wheels };
      result.operators = state.forklifts.map(snapshot => {
        const vehicle = graphics.scene.getObjectByName(snapshot.id);
        const operator = vehicle.getObjectByName('ForkliftOperator');
        if (!operator) return { id: snapshot.id, exists: false };
        const previousPosition = vehicle.position.clone(), previousYaw = vehicle.rotation.y;
        vehicle.position.set(0, 0, 0); vehicle.rotation.y = 0; vehicle.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(operator);
        vehicle.position.set(4, 0, -7); vehicle.rotation.y = Math.PI / 2; vehicle.updateMatrixWorld(true);
        const origin = operator.getWorldPosition(new THREE.Vector3()).toArray();
        const head = operator.getObjectByName('OperatorHead').getWorldPosition(new THREE.Vector3()).toArray();
        const meshCount = operator.children.reduce((total, child) => total + (child.isMesh ? 1 : child.children.filter(item => item.isMesh).length), 0);
        vehicle.position.copy(previousPosition); vehicle.rotation.y = previousYaw;
        return { id: snapshot.id, exists: true, attached: operator.parent === vehicle, min: bounds.min.toArray(), max: bounds.max.toArray(), origin, head, meshCount };
      });
      result.shutters = [0, 0.5, 1].map(openness => {
        graphics.update({ ...state, gates: { in: openness, out: openness } });
        return ['in', 'out'].map(id => {
          const gate = graphics.scene.getObjectByName(`simulation-gate-${id}`);
          const panel = gate.children[0];
          return { id, openness, visible: panel.visible, lowerEdge: panel.position.y - panel.scale.y / 2, upperEdge: panel.position.y + panel.scale.y / 2 };
        });
      }).flat();
      result.mastClearances = dockingStates.map(({ state, truckIndex, rackIndex }) => {
        graphics.update(state);
        graphics.scene.updateMatrixWorld(true);
        const object = graphics.scene.getObjectByName(state.forklifts[truckIndex].id);
        let mastFront = -Infinity;
        object.traverse(node => {
          if (node.name === 'ForkliftMastOuter' || node.name === 'ForkliftCarriageForks' || node.name.includes('-mast-stage-')) {
            mastFront = Math.max(mastFront, new THREE.Box3().setFromObject(node).max.z);
          }
        });
        const rack = model.layout.racks[rackIndex];
        return { role: state.forklifts[truckIndex].role, clearance: rack.z - rack.depth / 2 - 0.065 - mastFront };
      });
      graphics.dispose(); model.dispose();
      return result;
    }, dockingStates);
    assert.ok(rigBounds.body.min[0] >= -0.7 && rigBounds.body.max[0] <= 0.7, 'Rendered body fits the tested collision width');
    assert.ok(rigBounds.body.min[2] >= -1.8 && rigBounds.body.max[2] <= 0.9, 'Rendered body fits the tested fore/aft envelope');
    assert.equal(rigBounds.wheels.length, 4);
    assert.equal(rigBounds.operators.length, 3);
    for (const operator of rigBounds.operators) {
      assert.ok(operator.exists && operator.attached, 'Each forklift carries its own seated operator');
      assert.ok(operator.min[0] > -0.4 && operator.max[0] < 0.4, 'Operator stays within the cabin width');
      assert.ok(operator.min[1] >= 0.5 && operator.max[1] < 2.2, 'Boots stay above the floor and helmet below the canopy');
      assert.ok(operator.min[2] > -1.1 && operator.max[2] < 0.4, 'Seated body fits between the seat back and controls');
      assert.deepEqual(operator.origin, [4, 0, -7], 'Driver position follows the chassis');
      assert.ok(operator.head[0] < 4 && Math.abs(operator.head[2] + 7) < 0.001, 'Head follows the chassis rotation');
      assert.ok(operator.meshCount <= 12, 'Anatomy is batched to keep the three drivers inexpensive to render');
    }
    assert.ok(rigBounds.wheels.every(radius => Number.isFinite(radius) && radius > 0), 'Every wheel has a usable physical radius');
    assert.ok(rigBounds.mastClearances.every(item => item.clearance >= 0.05), `Real mast and telescoping stages must clear the front shelf beams: ${JSON.stringify(rigBounds.mastClearances)}`);
    for (const shutter of rigBounds.shutters) {
      assert.equal(shutter.visible, shutter.openness < 1, 'Open shutters leave a clear portal');
      assert.ok(Math.abs(shutter.lowerEdge - 4.8 * shutter.openness) < 0.001);
      assert.ok(Math.abs(shutter.upperEdge - 4.8) < 0.001, 'Shutter rolls into the fixed overhead housing');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    console.log(JSON.stringify({ result: 'PASS', samples, screenshots: output, rigBounds, errors, forbidden }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
