// Exercise real Chromium decoding, gesture unlock and Web Audio processing.
// Instrumentation belongs only to this fixture, never to the shipped module.
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const publicRoot = path.resolve(__dirname, '../public');
const fixture = `<!doctype html><button id="start">Start audio</button>
<script type="module">
import { createSimulationAudio } from '/warehouse-simulation-audio.mjs';
window.audio = createSimulationAudio({ layout: { gateIn: { x: -12, y: 0, z: -35 }, gateOut: { x: 13, y: 0, z: -35 } } });
window.audioReady = true;
document.querySelector('button').onclick = () => { window.unlocked = audio.resume(); };
</script>`;

async function measureAttenuation(page, duration, pannerIndex) {
  return page.evaluate(async ({ duration, pannerIndex }) => {
    const live = observedAudioContexts[0];
    const settings = live.panners[pannerIndex];
    const buffer = live.sources.find(source => Math.abs(source.buffer.duration - duration) < 0.001).buffer;
    async function energy(distance) {
      const offline = new OfflineAudioContext(2, 48000, 48000);
      const source = offline.createBufferSource();
      source.buffer = buffer;
      const panner = offline.createPanner();
      for (const key of ['panningModel', 'distanceModel', 'refDistance', 'maxDistance', 'rolloffFactor', 'coneInnerAngle', 'coneOuterAngle']) panner[key] = settings[key];
      panner.positionZ.value = -distance;
      source.connect(panner); panner.connect(offline.destination); source.start();
      const rendered = await offline.startRendering();
      let sum = 0;
      for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
        for (const sample of rendered.getChannelData(channel)) sum += sample * sample;
      }
      return Math.sqrt(sum / (rendered.length * rendered.numberOfChannels));
    }
    return { near: await energy(3), far: await energy(30) };
  }, { duration, pannerIndex });
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(publicRoot, 'audio/warehouse/manifest.json'), 'utf8'));
  const gateDurations = [manifest.assets['gate-open'].duration, manifest.assets['gate-close'].duration];
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const file = path.resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : 'audio/wav');
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeContext = window.AudioContext;
      window.observedAudioContexts = [];
      window.AudioContext = class extends NativeContext {
        constructor(...args) { super(...args); window.observedAudioContexts.push(this); this.sources = []; this.panners = []; }
        createBufferSource() {
          const node = super.createBufferSource();
          node.addEventListener('ended', () => { node.hasEnded = true; });
          const stop = node.stop.bind(node);
          node.stop = (...args) => { node.wasStopped = true; return stop(...args); };
          this.sources.push(node); return node;
        }
        createPanner() { const node = super.createPanner(); this.panners.push(node); return node; }
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.audioReady);
    assert.equal(await page.evaluate(() => observedAudioContexts.length), 0, 'Fetching audio does not create an audio device before a gesture');
    await page.locator('#start').click();
    assert.equal(await page.evaluate(() => unlocked), true);
    await page.locator('#start').click();
    assert.equal(await page.evaluate(() => unlocked), true);
    assert.equal(await page.evaluate(() => observedAudioContexts.length), 1);
    await page.evaluate(() => {
      window.truck = { id: 'inbound', position: { x: 7, y: 0, z: -11 }, yaw: Math.PI / 2, visible: true, engineRunning: true, speed: -1, liftVelocity: 0.1 };
      window.camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1] } };
      audio.update({ forklifts: [truck] }, camera);
    });
    // AudioParam automation takes effect on a render quantum, not synchronously.
    await page.waitForFunction(() => observedAudioContexts[0].panners[0].positionX.value === 7);
    const initial = await page.evaluate(() => {
      const context = observedAudioContexts[0];
      return { state: context.state, sources: context.sources.length, durations: context.sources.map(source => source.buffer.duration), panners: context.panners.length, listener: [context.listener.positionX.value, context.listener.positionY.value, context.listener.positionZ.value], forwardZ: context.listener.forwardZ.value };
    });
    assert.equal(initial.state, 'running');
    assert.equal(initial.sources, 4, 'Startup, scheduled idle, reversing and hydraulics are independent sources');
    assert.equal(initial.panners, 1);
    assert.deepEqual(initial.listener, [3, 4, 5]);
    assert.equal(initial.forwardZ, -1);
    assert.ok(Math.abs(initial.durations[0] - 2.4) < 0.001);
    assert.ok(Math.abs(initial.durations[1] - 7.76) < 0.001);
    assert.equal(initial.durations[3], 1.5, 'The actual decoder receives exactly the selected hydraulics interval');

    const attenuation = await measureAttenuation(page, 7.76, 0);
    assert.ok(attenuation.near > 0.001, 'The processed engine clip contains audible samples');
    assert.ok(attenuation.far < attenuation.near / 5, 'The actual browser panner makes the same truck quieter at a distance');

    await page.waitForTimeout(2600);
    await page.evaluate(() => {
      audio.update({ forklifts: [{ ...truck, speed: 0, liftVelocity: 0, engineRunning: false, visible: false }] }, camera);
    });
    assert.equal(await page.evaluate(() => observedAudioContexts[0].sources.length), 5, 'Hiding the truck emits one shutdown tail');
    await page.evaluate(() => {
      window.gateState = (inbound, outbound) => ({ forklifts: [{ ...truck, speed: 0, liftVelocity: 0, engineRunning: false }], gates: { in: inbound, out: outbound } });
      audio.update(gateState(0, 1), camera);
      audio.update(gateState(0.1, 0.9), camera);
    });
    await page.waitForFunction(() => observedAudioContexts[0].panners[2].positionX.value === 13);
    const renderedGates = await page.evaluate(() => {
      const context = observedAudioContexts[0];
      return { durations: context.sources.slice(5).map(source => source.buffer.duration), positions: context.panners.slice(1).map(panner => [panner.positionX.value, panner.positionZ.value]) };
    });
    assert.deepEqual(renderedGates.positions, [[-12, -35], [13, -35]]);
    renderedGates.durations.forEach((duration, index) => assert.ok(Math.abs(duration - gateDurations[index]) < 1 / manifest.sampleRate, 'Decoder resampling preserves the complete recording'));
    const gateAttenuation = await measureAttenuation(page, gateDurations[0], 1);
    assert.ok(gateAttenuation.near > 0.01, 'The supplied door recording is audible');
    assert.ok(gateAttenuation.far < gateAttenuation.near / 5, 'A distant shutter is quieter than the same nearby shutter');
    await page.evaluate(() => {
      audio.update(gateState(0.4, 0.6), camera);
      audio.update(gateState(0.7, 0.3), camera);
    });
    assert.equal(await page.evaluate(() => observedAudioContexts[0].sources.length), 7, 'Gate movement frames reuse the same two samples');
    await page.evaluate(() => audio.update(gateState(1, 0), camera));
    assert.equal(await page.evaluate(() => observedAudioContexts[0].sources.slice(5).every(source => source.wasStopped || source.hasEnded)), true, 'Both shutters stop or finish their recording by the motion endpoint');
    await page.evaluate(() => audio.update(gateState(0.8, 0.2), camera));
    const returnDurations = await page.evaluate(() => observedAudioContexts[0].sources.slice(7).map(source => source.buffer.duration));
    assert.equal(returnDurations.length, 2, 'Return travel starts a fresh recording at each gate');
    returnDurations.forEach((duration, index) => assert.ok(Math.abs(duration - gateDurations[1 - index]) < 1 / manifest.sampleRate));
    await page.evaluate(() => audio.setPaused(true));
    assert.equal(await page.evaluate(() => observedAudioContexts[0].state), 'suspended');
    await page.evaluate(() => audio.setPaused(false));
    assert.equal(await page.evaluate(() => observedAudioContexts[0].state), 'running');
    assert.equal(await page.evaluate(() => observedAudioContexts[0].sources.length), 9, 'Visibility resume preserves existing gate loops');
    await page.evaluate(() => audio.dispose());
    await page.waitForFunction(() => observedAudioContexts[0].state === 'closed');
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => observedAudioContexts[0].sources.slice(5).every(source => source.wasStopped || source.hasEnded)), true, 'Disposal leaves no playing shutter sources');
    console.log(JSON.stringify({ passed: true, checks: ['gesture unlock', 'real WAV decode', 'per-truck source graph', 'camera listener', 'distance attenuation', 'shutdown', 'positional roller shutters', 'gate distance attenuation', 'gate motion endpoints', 'gate direction changes', 'pause and resume', 'dispose'], attenuation, gateAttenuation, errors }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
