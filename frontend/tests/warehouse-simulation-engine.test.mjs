import assert from 'node:assert/strict';
import { createSimulation } from '../public/warehouse-simulation-engine.mjs';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-7, `${message}: ${a} versus ${b}`);

function rectangle(position, yaw, halfWidth, rear, front) {
  return [-halfWidth, halfWidth].flatMap(x => [rear, front].map(z => ({
    x: position.x + x * Math.cos(yaw) + z * Math.sin(yaw),
    z: position.z - x * Math.sin(yaw) + z * Math.cos(yaw),
  })));
}

function overlaps(a, yawA, b, yawB) {
  for (const yaw of [yawA, yawB]) {
    for (const axis of [{ x: Math.cos(yaw), z: -Math.sin(yaw) }, { x: Math.sin(yaw), z: Math.cos(yaw) }]) {
      const aa = a.map(p => p.x * axis.x + p.z * axis.z);
      const bb = b.map(p => p.x * axis.x + p.z * axis.z);
      if (Math.max(...aa) <= Math.min(...bb) + 1e-7 || Math.max(...bb) <= Math.min(...aa) + 1e-7) return false;
    }
  }
  return true;
}

test('empty racks and one staging point reserve 250 stable identities across three independent trucks', () => {
  const simulation = createSimulation();
  const state = simulation.getState();
  assert.equal(state.boxes.length, 250);
  assert.equal(new Set(state.boxes.map(box => box.id)).size, 250);
  assert.ok(state.boxes.every(box => box.location.kind === 'pending' && box.visible === false));
  assert.equal(simulation.layout.floorPositions.length, 1);
  assert.deepEqual(simulation.layout.floorPositions[0], { x: -12, y: 0, z: -29 });
  assert.equal(simulation.layout.racks.length, 5);
  assert.deepEqual(simulation.layout.racks.map(rack => rack.z), [-22, -11, 0, 11, 22]);
  assert.equal(state.forklifts.length, 3);
  assert.deepEqual(state.forklifts.map(truck => truck.role), ['putaway', 'outbound', 'inbound']);
  assert.equal(new Set(state.forklifts.map(truck => truck.id)).size, 3);
  assert.equal(state.forklifts[1].visible, false);
  assert.equal(state.storedCount, 0);
  assert.equal(state.shippedCount, 0);
  assert.ok(Number.isFinite(simulation.cycleDuration) && simulation.cycleDuration > 100);
});

test('two complete cycles feed one floor box, store all cells once in order and ship FIFO while putaway continues', { timeout: 30000 }, () => {
  const simulation = createSimulation();
  const ids = simulation.getState().boxes.map(box => box.id);
  const stored = [[], []], shipped = [[], []];
  const previousKinds = ids.map(() => 'pending');
  let previousCycle = 0, sawParallel = false, sawDescent = false;
  for (let time = 0; time < simulation.cycleDuration * 2 + 1; time += 0.5) {
    const state = simulation.getState();
    if (state.cycle === 2) break;
    if (state.cycle !== previousCycle) previousKinds.fill('pending');
    previousCycle = state.cycle;
    assert.equal(state.boxes.length, 250);
    const floor = state.boxes.filter(box => box.location.kind === 'floor');
    assert.ok(floor.length <= 1, 'at most one box waits on the floor');
    const cells = new Set();
    let lastStoredIndex = stored[state.cycle].length - 1;
    for (let index = 0; index < state.boxes.length; index++) {
      const box = state.boxes[index];
      assert.equal(box.id, ids[index]);
      if (box.location.kind === 'rack') {
        const cell = `${box.location.rack}:${box.location.shelf}:${box.location.slot}:${box.location.side}`;
        assert.ok(!cells.has(cell), 'each of the two sides holds at most one box');
        cells.add(cell);
        assert.ok(box.location.side === 0 || box.location.side === 1);
        if (previousKinds[index] !== 'rack') {
          assert.equal(index, stored[state.cycle].length, 'putaway follows stable identity order without refilling cleared cells');
          assert.deepEqual(box.location, {
            kind: 'rack', rack: Math.floor(index / 50), shelf: Math.floor(index % 50 / 10),
            slot: Math.floor(index % 10 / 2), side: index % 2,
          });
          stored[state.cycle].push(box.id);
          lastStoredIndex = index;
        }
      }
      if (box.location.kind === 'shipped' && previousKinds[index] !== 'shipped') {
        assert.equal(box.id, ids[shipped[state.cycle].length], 'Gate Out receives FIFO');
        assert.equal(box.visible, false);
        shipped[state.cycle].push(box.id);
      }
      if (box.location.kind === 'floor') assert.ok(index <= lastStoredIndex + 1, 'inbound waits for the previous putaway');
      previousKinds[index] = box.location.kind;
    }
    const outgoing = state.forklifts[1];
    if (outgoing.visible) assert.ok(state.storedCount >= 50, 'outbound appears only after rack 1 contains 50');
    if (outgoing.visible && outgoing.position.y > 0 && state.shippedCount === 0) sawDescent = true;
    if (state.storedCount > 50 && state.storedCount < 250 && outgoing.cargoId) sawParallel = true;
    assert.equal(state.storedCount, stored[state.cycle].length);
    assert.equal(state.shippedCount, shipped[state.cycle].length);
    simulation.step(0.5);
  }
  assert.equal(simulation.getState().cycle, 2);
  for (const entries of [...stored, ...shipped]) assert.deepEqual(entries, ids);
  assert.ok(sawParallel, 'outbound runs while later racks are being filled');
  assert.ok(sawDescent, 'truck 2 visibly descends at its safe start');
});

test('all trucks and visible boxes move continuously, attach to their own forks, and avoid racks and each other', { timeout: 30000 }, () => {
  const simulation = createSimulation();
  const dt = 0.4;
  let previous = simulation.getState();
  const actions = new Set();
  const rackRectangles = simulation.layout.racks.map(rack => rectangle({ x: rack.x, z: rack.z }, 0, rack.width / 2, -rack.depth / 2, rack.depth / 2));
  while (previous.cycle === 0) {
    const state = simulation.step(dt);
    // Bounds include the actual normalized GLB body (width1.34, rear-1.78),
    // not only the previous procedural truck's smaller chassis.
    const bodies = state.forklifts.map(truck => rectangle(truck.position, truck.yaw, 0.7, -1.8, 0.9));
    state.forklifts.forEach((truck, i) => {
      actions.add(truck.action);
      const before = previous.forklifts[i];
      assert.ok(distance(before.position, truck.position) <= 6.8 * dt + 1e-7, `${truck.role} never teleports`);
      assert.ok(angleDistance(before.yaw, truck.yaw) <= 2.11 * dt + 1e-7, `${truck.role} never snaps its heading`);
      assert.ok(Math.abs(before.liftHeight - truck.liftHeight) <= 1.21 * dt + 1e-7, `${truck.role} lift stays continuous`);
      if (!truck.visible || truck.position.y > 10.5) return;
      rackRectangles.forEach((rackBody, j) => assert.ok(!overlaps(bodies[i], truck.yaw, rackBody, 0), `${truck.role} chassis stays outside rack ${j + 1}`));
      for (let j = 0; j < i; j++) {
        if (state.forklifts[j].visible && Math.abs(truck.position.y - state.forklifts[j].position.y) < 2.5) {
          assert.ok(!overlaps(bodies[i], truck.yaw, bodies[j], state.forklifts[j].yaw), 'truck chassis never collide');
        }
      }
      for (const box of state.boxes.filter(box => box.location.kind === 'floor')) {
        assert.ok(!overlaps(bodies[i], truck.yaw, rectangle(box.position, box.rotationY, 0.6, -0.6, 0.6), box.rotationY), 'chassis stays outside floor box');
      }
    });
    state.boxes.forEach((box, index) => {
      const before = previous.boxes[index];
      if (box.visible && before.visible) {
        assert.ok(distance(before.position, box.position) < 12 * dt + 1e-7, `visible ${box.id} never teleports`);
        assert.ok(angleDistance(before.rotationY, box.rotationY) <= 2.11 * dt + 1e-7, 'box rotation is continuous through pickup and placement');
      }
      if (box.location.kind !== 'carried') return;
      const truck = state.forklifts.find(item => item.id === box.location.forkliftId);
      assert.ok(truck && truck.cargoId === box.id, 'only the owning truck carries this box');
      close(box.position.x, truck.position.x + Math.sin(truck.yaw) * 1.55, 'fork X');
      close(box.position.z, truck.position.z + Math.cos(truck.yaw) * 1.55, 'fork Z');
      close(box.position.y, truck.position.y + truck.liftHeight, 'fork height');
    });
    previous = state;
  }
  for (const action of ['drive', 'turn', 'lift', 'insert', 'retract', 'pickup', 'place', 'descend']) assert.ok(actions.has(action), `observable ${action}`);
});

test('snapshots are isolated, invalid time has no effect, and disposing freezes the simulation', () => {
  const simulation = createSimulation();
  const before = simulation.getState(), changed = simulation.getState();
  changed.boxes[0].position.x = 12345;
  changed.boxes[0].location.kind = 'carried';
  changed.forklifts[0].position.z = -12345;
  changed.forklift.position.x = -12345;
  assert.deepEqual(simulation.getState(), before);
  for (const dt of [0, -1, NaN, Infinity, -Infinity, undefined, null, '1']) assert.deepEqual(simulation.step(dt), before);
  const moved = simulation.step(2);
  assert.notDeepEqual(moved, before);
  simulation.dispose();
  simulation.dispose();
  assert.deepEqual(simulation.step(100000), moved);
});

test('arbitrary time partitions and enormous deltas have bounded work and preserve deterministic poses', { timeout: 6000 }, () => {
  const one = createSimulation(), many = createSimulation();
  const elapsed = one.cycleDuration * 2.25;
  const once = one.step(elapsed);
  for (let i = 0; i < 1000; i++) many.step(elapsed / 1000);
  const split = many.getState();
  assert.equal(once.cycle, split.cycle);
  assert.equal(once.phase, split.phase);
  assert.equal(once.storedCount, split.storedCount);
  assert.equal(once.shippedCount, split.shippedCount);
  once.forklifts.forEach((truck, i) => {
    assert.equal(truck.cargoId, split.forklifts[i].cargoId);
    assert.ok(distance(truck.position, split.forklifts[i].position) < 1e-7);
    close(truck.liftHeight, split.forklifts[i].liftHeight, 'partitioned lift');
  });
  once.boxes.forEach((box, i) => {
    assert.deepEqual(box.location, split.boxes[i].location);
    assert.ok(distance(box.position, split.boxes[i].position) < 1e-7);
  });
  const enormous = one.step(Number.MAX_VALUE);
  assert.ok(Number.isFinite(enormous.cycle) && enormous.cycle > once.cycle);
  for (const truck of enormous.forklifts) assert.ok([...Object.values(truck.position), truck.yaw, truck.liftHeight].every(Number.isFinite));
});
