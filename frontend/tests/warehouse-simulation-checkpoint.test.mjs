import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { createSimulation } from '../public/warehouse-simulation-engine.mjs';
import { createCheckpointStore, checkpointProfile } from '../public/warehouse-simulation-checkpoint.mjs';
import { createSessionExpiryGuard, hasFullscreenSimulation } from '../public/warehouse-session-expiry.mjs';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const view = () => ({ mode: 'first-person', orbit: { position: [-17, 10, -24], target: [0, 3, 0], zoom: 1 }, walkingPosition: [-17, 1.72, -27], lookYaw: -2.2, lookPitch: 0.25, buildingVisible: false, uiHidden: true });
const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map }; };

test('checkpoint resumes deterministic cargo, doors and vehicles mid-transfer across cycles', () => {
  const original = createSimulation(), resumed = createSimulation();
  for (const time of [13.47, 43.25, 2837.16, original.cycleDuration * 2.13]) {
    original.step(time);
    const saved = original.checkpoint();
    assert.ok(JSON.stringify(saved).length < 200, 'save only time/cycle, not all stock');
    assert.equal(resumed.restore(JSON.parse(JSON.stringify(saved))), true);
    assert.deepEqual(resumed.getState(), original.getState());
    assert.deepEqual(resumed.step(0.27), original.step(0.27), 'resuming continues identically');
  }
});

test('invalid or incompatible engine checkpoints cannot corrupt the current simulation', () => {
  const simulation = createSimulation(), initial = simulation.getState(), saved = simulation.checkpoint();
  for (const value of [null, {}, { ...saved, version: 2 }, { ...saved, timeline: 'old' }, { ...saved, duration: 1 }, { ...saved, elapsed: Infinity }, { ...saved, elapsed: -1 }, { ...saved, elapsed: simulation.cycleDuration }, { ...saved, cycle: -1 }, { ...saved, cycle: 1.5 }]) {
    assert.equal(simulation.restore(value), false);
    assert.deepEqual(simulation.getState(), initial);
  }
});

test('browser saves are bounded, account-scoped and retain view without retaining tokens', () => {
  const memory = storage(), engine = createSimulation().checkpoint();
  memory.setItem('smarttrace_jwt', jwt({ sub: 1, username: 'user1' }));
  const profile = checkpointProfile(memory), first = createCheckpointStore({ storage: memory, profile });
  memory.setItem('boxtrace_jwt', jwt({ sub: 999, username: 'stale-alias' }));
  assert.equal(checkpointProfile(memory), profile, 'the WEB auth key takes precedence over a stale legacy alias');
  assert.equal(checkpointProfile(memory, jwt({ sub: 5 })), 'user:5', 'the host can select the actual account token on older deployments');
  assert.equal(first.save(engine, view()), true);
  const loaded = first.load();
  assert.deepEqual(loaded.view, view()); assert.deepEqual(loaded.engine, engine);
  assert.ok(JSON.stringify(loaded).length < 1000);
  assert.ok(!JSON.stringify(loaded).includes('signature'));
  memory.setItem('smarttrace_jwt', jwt({ sub: 2, username: 'user2' }));
  assert.equal(createCheckpointStore({ storage: memory, profile: checkpointProfile(memory) }).load(), null);
  memory.setItem('smarttrace_jwt', jwt({ sub: 1, employeeId: '1', username: 'user1' }));
  assert.notEqual(checkpointProfile(memory), profile, 'employee and user ids do not collide');
  memory.setItem('smarttrace_jwt', jwt({ sub: 1, username: 'renamed-user' }));
  assert.equal(checkpointProfile(memory), profile, 'account renames preserve progress');
  assert.equal(createCheckpointStore({ storage: memory, profile }).load().view.mode, 'first-person');
});

test('corrupt records and denied/full browser storage do not stop simulation', () => {
  const memory = storage(), store = createCheckpointStore({ storage: memory });
  const key = 'boxtrace:warehouse-simulation:local';
  for (const value of ['{', 'x'.repeat(9000), JSON.stringify({ version: 1, engine: {}, view: { ...view(), lookPitch: 900 } }), JSON.stringify({ version: 2, engine: {}, view: view() })]) {
    memory.setItem(key, value); assert.equal(store.load(), null);
  }
  let errors = 0;
  const unavailable = createCheckpointStore({ storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } }, onError: () => errors++ });
  assert.equal(unavailable.load(), null);
  assert.equal(unavailable.save(createSimulation().checkpoint(), view()), false);
  assert.equal(errors, 1, 'do not repeat storage warnings every second');
});

function expiryFixture() {
  const dom = new JSDOM('<iframe></iframe>', { url: 'http://localhost/' });
  const win = dom.window, child = win.document.querySelector('iframe').contentWindow;
  const host = child.document.createElement('div'); host.className = 'warehouse-simulation-host'; child.document.body.appendChild(host);
  Object.defineProperty(child.document, 'fullscreenElement', { configurable: true, value: host, writable: true });
  child.__warehouseSimulationActive = true;
  let token = jwt({ sub: 1, exp: Date.now() / 1000 - 1 }), expired = 0;
  const guard = createSessionExpiryGuard({ window: win, getToken: () => token, onExpire: () => expired++ });
  return { win, child, guard, setToken: value => { token = value; }, expired: () => expired, close: () => { guard.dispose(); dom.window.close(); } };
}

test('expired login stays intact while actual nested fullscreen runs and expires on exit', () => {
  const f = expiryFixture();
  try {
    assert.equal(hasFullscreenSimulation(f.win), true); assert.equal(f.expired(), 0);
    f.win.dispatchEvent(new f.win.MessageEvent('message', { data: { type: 'warehouse-simulation-change', active: false } }));
    assert.equal(f.expired(), 0, 'messages cannot spoof fullscreen ownership');
    f.guard.expire(); assert.equal(f.expired(), 0, 'in-flight 401 also waits');
    f.child.__warehouseSimulationActive = false;
    f.win.dispatchEvent(new f.win.CustomEvent('warehouse-simulation-change', { detail: { active: false } }));
    assert.equal(f.expired(), 1);
    f.guard.expire(); assert.equal(f.expired(), 1, 'only one navigation');
  } finally { f.close(); }
});

test('token rotation is rechecked, and stale active flags without fullscreen do not suppress expiry', () => {
  const f = expiryFixture();
  try {
    f.guard.expire();
    f.setToken(jwt({ sub: 1, exp: Date.now() / 1000 + 300 }));
    f.child.__warehouseSimulationActive = false;
    f.win.dispatchEvent(new f.win.CustomEvent('warehouse-simulation-change'));
    assert.equal(f.expired(), 0, 'a valid new token clears stale denial');
    f.child.__warehouseSimulationActive = true;
    f.child.document.fullscreenElement = null;
    assert.equal(hasFullscreenSimulation(f.win), false);
    f.setToken(jwt({ sub: 1, exp: Date.now() / 1000 - 1 }));
    f.win.dispatchEvent(new f.win.Event('storage'));
    assert.equal(f.expired(), 1);
  } finally { f.close(); }
});

test('a cross-tab logout waits for fullscreen exit and then navigates once', () => {
  const f = expiryFixture();
  try {
    f.setToken(null);
    f.win.dispatchEvent(new f.win.Event('storage'));
    assert.equal(f.expired(), 0);
    f.child.__warehouseSimulationActive = false;
    f.win.dispatchEvent(new f.win.CustomEvent('warehouse-simulation-change'));
    assert.equal(f.expired(), 1);
  } finally { f.close(); }
});

test('legacy 401 reaches the guard before deferral so a new valid token survives exit', async () => {
  const f = expiryFixture();
  try {
    const html = await readFile(new URL('../public/legacy.html', import.meta.url), 'utf8');
    const source = html.match(/function handleSessionExpired\(\)\{[\s\S]*?\n\}/)[0];
    const win = { smarttraceSessionExpired: f.guard.expire, WarehouseSimulation: { deferSessionExpiry() { throw Error('guard already owns deferral'); } } };
    const legacyExpired = new Function('window', `return (${source});`)(win);
    legacyExpired();
    f.setToken(jwt({ sub: 1, exp: Date.now() / 1000 + 300 }));
    f.win.dispatchEvent(new f.win.Event('storage'));
    f.child.__warehouseSimulationActive = false;
    f.win.dispatchEvent(new f.win.CustomEvent('warehouse-simulation-change'));
    assert.equal(f.expired(), 0);
  } finally { f.close(); }
});
