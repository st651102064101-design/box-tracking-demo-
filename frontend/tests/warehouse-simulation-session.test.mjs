const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let createSimulationSession;
try { ({ createSimulationSession } = await import('../public/warehouse-simulation-session.mjs')); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function fixture({ rejectFullscreen = false, busy = false, pendingFullscreen = false } = {}) {
  assert.equal(typeof createSimulationSession, 'function', 'simulation session implementation must exist');
  const dom = new JSDOM('<button id="entry">Start</button><div id="stage"><canvas></canvas></div>', { url: 'http://localhost:3000/legacy.html' });
  const win = dom.window, doc = win.document;
  let suspended = 0, resumed = 0, apiCalls = 0, finishFullscreen;
  const errors = [], posted = [];
  const controller = { suspendForSimulation() { if (busy) return false; suspended++; return true; }, resumeFromSimulation() { resumed++; } };
  doc.fullscreenElement = null;
  win.HTMLElement.prototype.requestFullscreen = function () {
    if (rejectFullscreen) return Promise.reject(new Error('Fullscreen denied'));
    const activate = () => { doc.fullscreenElement = this; doc.dispatchEvent(new win.Event('fullscreenchange')); };
    if (pendingFullscreen) return new Promise(resolve => { finishFullscreen = () => { activate(); resolve(); }; });
    activate();
    return Promise.resolve();
  };
  doc.exitFullscreen = async () => { doc.fullscreenElement = null; doc.dispatchEvent(new win.Event('fullscreenchange')); };
  win.fetch = async () => { apiCalls++; return { ok: true }; };
  const originalFetch = win.fetch;
  const session = createSimulationSession({ window: win, getController: () => controller, onError: message => errors.push(message) });
  const ready = () => {
    const frame = doc.querySelector('iframe');
    frame.contentWindow.postMessage = msg => posted.push(msg);
    win.dispatchEvent(new win.MessageEvent('message', { source: frame.contentWindow, origin: win.location.origin, data: { type: 'warehouse-simulation-ready' } }));
  };
  return { win, doc, session, ready, errors, posted, originalFetch, finishFullscreen: () => finishFullscreen(), stats: () => ({ suspended, resumed, apiCalls }), close() { session.dispose(); dom.window.close(); } };
}

test('start waits for fullscreen and child readiness; exit restores the preserved controller', async () => {
  const f = fixture();
  try {
    f.doc.getElementById('entry').focus();
    await f.session.enter();
    assert.equal(f.win.__warehouseSimulationActive, true);
    assert.equal(f.posted.length, 0);
    f.ready();
    assert.deepEqual(f.posted, [{ type: 'warehouse-simulation-start' }]);
    await f.session.exit();
    assert.equal(f.doc.querySelector('iframe'), null);
    assert.equal(f.win.__warehouseSimulationActive, false);
    assert.equal(f.doc.activeElement.id, 'entry');
    assert.deepEqual(f.stats(), { suspended: 1, resumed: 1, apiCalls: 0 });
  } finally { f.close(); }
});

test('fullscreen rejection rolls back instead of running a non-fullscreen simulation', async () => {
  const f = fixture({ rejectFullscreen: true });
  try {
    assert.equal(await f.session.enter(), false);
    assert.equal(f.doc.querySelector('iframe'), null);
    assert.equal(f.win.__warehouseSimulationActive, false);
    assert.equal(f.stats().resumed, 1);
    assert.equal(f.errors.length, 1);
  } finally { f.close(); }
});

test('busy real forklift prevents entering or altering the real scene', async () => {
  const f = fixture({ busy: true });
  try { assert.equal(await f.session.enter(), false); assert.equal(f.doc.querySelector('iframe'), null); assert.equal(f.stats().resumed, 0); }
  finally { f.close(); }
});

test('API reads and writes are blocked during simulation and original fetch is restored on exit', async () => {
  const f = fixture();
  try {
    await f.session.enter();
    await assert.rejects(f.win.fetch('/api/state'), { name: 'AbortError' });
    await assert.rejects(f.win.fetch('http://localhost:4000/api/boxes/test/putaway', { method: 'POST' }), { name: 'AbortError' });
    assert.equal(f.stats().apiCalls, 0);
    await f.session.exit();
    assert.equal(f.win.fetch, f.originalFetch);
    await f.win.fetch('/api/state');
    assert.equal(f.stats().apiCalls, 1);
  } finally { f.close(); }
});

test('repeated start and repeated exit do not duplicate scenes or resume twice', async () => {
  const f = fixture();
  try {
    await f.session.enter(); await f.session.enter(); f.ready(); f.ready();
    assert.equal(f.doc.querySelectorAll('iframe').length, 1);
    assert.equal(f.posted.length, 1);
    await f.session.exit(); await f.session.exit();
    assert.equal(f.stats().resumed, 1);
    await f.session.enter(); f.ready(); await f.session.exit();
    assert.equal(f.stats().suspended, 2); assert.equal(f.stats().resumed, 2);
  } finally { f.close(); }
});

test('untrusted or stale message cannot start or exit the simulation', async () => {
  const f = fixture();
  try {
    await f.session.enter();
    f.win.dispatchEvent(new f.win.MessageEvent('message', { origin: 'https://other.invalid', source: f.doc.querySelector('iframe').contentWindow, data: { type: 'warehouse-simulation-exit' } }));
    f.win.dispatchEvent(new f.win.MessageEvent('message', { origin: f.win.location.origin, source: f.win, data: { type: 'warehouse-simulation-exit' } }));
    assert.equal(f.win.__warehouseSimulationActive, true);
  } finally { f.close(); }
});

test('Escape and native fullscreen loss each exit the entire session', async () => {
  const f = fixture();
  try {
    await f.session.enter(); f.ready();
    f.win.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
    assert.equal(f.doc.querySelector('iframe'), null);
    await f.session.enter(); f.ready(); await f.doc.exitFullscreen();
    assert.equal(f.doc.querySelector('iframe'), null);
    assert.equal(f.stats().resumed, 2);
  } finally { f.close(); }
});

test('early Escape during pending fullscreen cannot resurrect a cancelled simulation', async () => {
  const f = fixture({ pendingFullscreen: true });
  try {
    const entering = f.session.enter();
    await f.session.exit();
    f.finishFullscreen(); await entering;
    assert.equal(f.doc.querySelector('iframe'), null);
    assert.equal(f.doc.fullscreenElement, null);
    assert.equal(f.stats().resumed, 1);
  } finally { f.close(); }
});

test('child error restores original scene and reports the failure', async () => {
  const f = fixture();
  try {
    await f.session.enter();
    f.win.dispatchEvent(new f.win.MessageEvent('message', { origin: f.win.location.origin, source: f.doc.querySelector('iframe').contentWindow, data: { type: 'warehouse-simulation-error', message: 'WebGL unavailable' } }));
    await Promise.resolve();
    assert.equal(f.doc.querySelector('iframe'), null); assert.equal(f.errors.length, 1);
  } finally { f.close(); }
});

test('native fullscreen loss flushes the child before removal and deferred expiry', async () => {
  const f = fixture(), order = [];
  try {
    await f.session.enter(); f.ready();
    const frame = f.doc.querySelector('iframe');
    frame.contentWindow.addEventListener('warehouse-simulation-save', () => {
      assert.ok(frame.isConnected); order.push('saved');
    });
    assert.equal(f.session.deferSessionExpiry(() => { assert.equal(frame.isConnected, false); order.push('expired'); }), true);
    await f.doc.exitFullscreen();
    assert.deepEqual(order, ['saved', 'expired']);
    assert.equal(f.session.deferSessionExpiry(() => {}), false);
  } finally { f.close(); }
});
