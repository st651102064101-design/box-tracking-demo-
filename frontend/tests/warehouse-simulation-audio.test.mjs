import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const audioModule = await import('../public/warehouse-simulation-audio.mjs').catch(() => ({}));

function audioBoundary() {
  const contexts = [];
  const parameter = () => ({ value: 0, events: [], setValueAtTime(value, time) { this.value = value; this.events.push([value, time]); }, linearRampToValueAtTime(value, time) { this.value = value; this.events.push([value, time]); }, setTargetAtTime(value, time) { this.value = value; this.events.push([value, time]); }, cancelScheduledValues() {} });
  const node = () => ({ connected: [], disconnected: false, connect(other) { this.connected.push(other); return other; }, disconnect() { this.disconnected = true; } });
  class Context {
    constructor() {
      this.currentTime = 0; this.state = 'suspended'; this.sources = []; this.panners = []; this.nodes = [];
      this.destination = node(); this.listener = {};
      for (const key of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) this.listener[key] = parameter();
      contexts.push(this);
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { const result = { ...node(), gain: parameter() }; this.nodes.push(result); return result; }
    createDynamicsCompressor() { const result = node(); for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) result[key] = parameter(); this.nodes.push(result); return result; }
    createPanner() { const result = node(); for (const key of ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ']) result[key] = parameter(); this.panners.push(result); this.nodes.push(result); return result; }
    createBufferSource() {
      const result = { ...node(), playbackRate: parameter(), start(time = 0) { this.started = time; }, stop(time = 0) { this.stopped = time; } };
      this.sources.push(result); this.nodes.push(result); return result;
    }
    async decodeAudioData(bytes) {
      const view = new DataView(bytes);
      return { duration: view.getUint32(40, true) / view.getUint32(28, true), numberOfChannels: view.getUint16(22, true) };
    }
  }
  const oldContext = globalThis.AudioContext;
  const oldFetch = globalThis.fetch;
  globalThis.AudioContext = Context;
  globalThis.fetch = async url => {
    const buffer = await fs.readFile(url);
    return { ok: true, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  };
  return { contexts, restore() { globalThis.AudioContext = oldContext; globalThis.fetch = oldFetch; } };
}

const camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1] }, updateMatrixWorld() {} };
const forklift = (id, changes = {}) => ({ id, position: { x: 0, y: 0, z: 0 }, yaw: 0, visible: true, speed: 0, liftVelocity: 0, engineRunning: true, ...changes });
const state = (...forklifts) => ({ forklifts });
const kind = source => source.buffer.duration > 7 ? 'idle' : source.buffer.duration > 2.3 ? 'start' : source.buffer.duration === 2 ? 'hydraulics' : source.buffer.duration > 1.5 ? 'stop' : 'reverse';
const active = context => context.sources.filter(source => source.stopped === undefined).map(kind);

test('audio waits for a gesture and creates only one context across repeated unlocks', async () => {
  assert.equal(typeof audioModule.createSimulationAudio, 'function', 'the simulation must expose its audio controller');
  const boundary = audioBoundary();
  const audio = audioModule.createSimulationAudio({});
  try {
    assert.equal(await audio.ready, true);
    audio.update(state(forklift('a')), camera);
    assert.equal(boundary.contexts.length, 0);
    assert.equal(await audio.resume(), true);
    await audio.resume();
    assert.equal(boundary.contexts.length, 1);
    assert.deepEqual(active(boundary.contexts[0]), ['start', 'idle']);
  } finally { audio.dispose(); boundary.restore(); }
});

test('reverse and hydraulics follow each vehicle independently, with one start per engine stint', async () => {
  const boundary = audioBoundary();
  const audio = audioModule.createSimulationAudio({});
  try {
    await audio.resume();
    audio.update(state(forklift('a', { speed: -2 }), forklift('b', { liftVelocity: 0.2 })), camera);
    const context = boundary.contexts[0];
    assert.deepEqual(active(context).sort(), ['hydraulics', 'idle', 'idle', 'reverse', 'start', 'start']);
    for (let i = 0; i < 20; i++) audio.update(state(forklift('a', { speed: -2 }), forklift('b', { liftVelocity: 0.2 })), camera);
    assert.equal(context.sources.length, 6, 'render frames must not restart samples');
    audio.update(state(forklift('a', { speed: 2 }), forklift('b')), camera);
    assert.deepEqual(active(context).sort(), ['idle', 'idle', 'start', 'start']);
    audio.update(state(forklift('a', { engineRunning: false, visible: false }), forklift('b')), camera);
    assert.deepEqual(active(context).sort(), ['idle', 'start', 'stop']);
    audio.update(state(forklift('a', { engineRunning: false, visible: false }), forklift('b')), camera);
    assert.equal(context.sources.filter(source => kind(source) === 'stop').length, 1, 'hidden parked trucks cannot repeat shutdown');
    audio.update(state(forklift('a'), forklift('b')), camera);
    assert.equal(context.sources.filter(source => kind(source) === 'start').length, 3, 'next engine stint starts once');
  } finally { audio.dispose(); boundary.restore(); }
});

test('positions use world camera transform and actual vehicle coordinates', async () => {
  const boundary = audioBoundary();
  const audio = audioModule.createSimulationAudio({});
  try {
    await audio.resume();
    audio.update(state(forklift('a', { position: { x: 7, y: 2, z: -11 }, yaw: Math.PI / 2 })), camera);
    const context = boundary.contexts[0];
    assert.equal(context.listener.positionX.value, 3);
    assert.equal(context.listener.positionY.value, 4);
    assert.equal(context.listener.positionZ.value, 5);
    assert.equal(context.listener.forwardZ.value, -1);
    assert.equal(context.listener.upY.value, 1);
    assert.equal(context.panners[0].positionX.value, 7);
    assert.ok(context.panners[0].positionY.value >= 2 && context.panners[0].positionY.value <= 3.5);
    assert.equal(context.panners[0].positionZ.value, -11);
    assert.ok(context.panners[0].orientationX.value > 0.99);
    assert.equal(context.panners[0].panningModel, 'HRTF');
    assert.equal(context.panners[0].distanceModel, 'inverse');
  } finally { audio.dispose(); boundary.restore(); }
});

test('pause resumes existing playback and abort stops every node and closes context', async () => {
  const boundary = audioBoundary();
  const abort = new AbortController();
  const audio = audioModule.createSimulationAudio({ signal: abort.signal });
  try {
    await audio.resume();
    audio.update(state(forklift('a', { speed: -1, liftVelocity: -0.1 })), camera);
    const context = boundary.contexts[0];
    const count = context.sources.length;
    await audio.setPaused(true);
    assert.equal(context.state, 'suspended');
    await audio.setPaused(false);
    assert.equal(context.state, 'running');
    assert.equal(context.sources.length, count);
    abort.abort();
    assert.equal(context.state, 'closed');
    assert.ok(context.sources.every(source => source.stopped !== undefined && source.disconnected));
    assert.ok(context.panners.every(panner => panner.disconnected));
    audio.update(state(forklift('a')), camera);
    assert.equal(await audio.resume(), false);
    assert.equal(context.sources.length, count);
  } finally { audio.dispose(); boundary.restore(); }
});

test('removed vehicles release their graph without stopping other vehicles', async () => {
  const boundary = audioBoundary();
  const audio = audioModule.createSimulationAudio({});
  try {
    await audio.resume();
    audio.update(state(forklift('a'), forklift('b')), camera);
    const context = boundary.contexts[0];
    audio.update(state(forklift('b')), camera);
    assert.equal(context.panners[0].disconnected, true);
    assert.equal(context.panners[1].disconnected, false);
    assert.deepEqual(active(context).sort(), ['idle', 'start']);
  } finally { audio.dispose(); boundary.restore(); }
});

test('loading failures are nonfatal and disposal during loading cannot revive playback', async () => {
  const boundary = audioBoundary();
  globalThis.fetch = async () => { throw new Error('offline'); };
  const failed = audioModule.createSimulationAudio({});
  try {
    assert.equal(await failed.ready, false);
    assert.equal(await failed.resume(), false);
    assert.doesNotThrow(() => failed.update(state(forklift('a')), camera));
  } finally { failed.dispose(); boundary.restore(); }
  const secondBoundary = audioBoundary();
  const disposed = audioModule.createSimulationAudio({});
  try {
    const unlocking = disposed.resume();
    disposed.dispose();
    assert.equal(await unlocking, false);
    assert.ok(secondBoundary.contexts.every(context => context.state === 'closed'));
  } finally { disposed.dispose(); secondBoundary.restore(); }
});

test('bundled hydraulics is mono and exactly the two seconds requested', async () => {
  const buffer = await fs.readFile(new URL('../public/audio/warehouse/hydraulics.wav', import.meta.url));
  assert.equal(buffer.readUInt16LE(22), 1);
  assert.equal(buffer.readUInt32LE(40) / buffer.readUInt32LE(28), 2);
  const manifest = JSON.parse(await fs.readFile(new URL('../public/audio/warehouse/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.assets.hydraulics.sourceStart, 7);
  assert.equal(manifest.assets.hydraulics.sourceEnd, 9);
});
