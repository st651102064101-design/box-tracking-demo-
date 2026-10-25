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

test('putaway descends through its own overhead bay once before the repeating ground cycle', () => {
  const simulation = createSimulation();
  assert.ok(Number.isFinite(simulation.introDuration) && simulation.introDuration > 10);
  const initial = simulation.getState();
  assert.deepEqual(initial.forklift.position, { x: -17, y: 14, z: -29 });
  assert.equal(initial.forklift.action, 'descend');
  assert.equal(initial.forklift.engineRunning, false);
  const descending = simulation.step(5);
  assert.ok(descending.forklift.position.y > 0 && descending.forklift.position.y < 14);
  assert.equal(descending.forklift.position.x, -17);
  assert.equal(descending.forklift.position.z, -29);
  assert.equal(descending.forklifts[2].visible, false);
  assert.ok(descending.boxes.every(box => !box.visible));
  const landed = simulation.step(simulation.introDuration - 5);
  assert.deepEqual(landed.forklift.position, { x: -12, y: 0, z: -25 });
  assert.equal(landed.cycle, 0);
  const nextCycle = simulation.step(simulation.cycleDuration);
  assert.equal(nextCycle.cycle, 1);
  assert.deepEqual(nextCycle.forklift.position, landed.forklift.position);
  assert.equal(nextCycle.forklift.position.y, 0);
  assert.notEqual(nextCycle.forklift.action, 'descend');
});

test('inbound reverses completely beyond the gate and hides between deliveries', () => {
  const simulation = createSimulation();
  let state = simulation.step(simulation.introDuration || 0);
  let sawDelivery = false, sawReverse = false, sawHiddenGap = false, sawNextDelivery = false;
  for (let time = 0; time < 180; time += 0.2) {
    state = simulation.step(0.2);
    const incoming = state.forklifts[2];
    if (incoming.cargoId === 'simulation-box-001') sawDelivery = true;
    if (sawDelivery && incoming.visible && incoming.action === 'retract') {
      sawReverse = true;
      assert.ok(incoming.speed <= 0, 'retraction has signed reverse speed');
    }
    if (sawReverse && !incoming.visible) {
      assert.ok(incoming.position.z + 2.25 < -35, 'the complete fork assembly clears the threshold before hiding');
      if (incoming.action === 'wait') {
        sawHiddenGap = true;
        assert.equal(incoming.engineRunning, false);
      }
      assert.equal(incoming.cargoId, null);
    }
    if (incoming.cargoId === 'simulation-box-002') {
      sawNextDelivery = true;
      assert.ok(sawHiddenGap, 'each delivery starts after a hidden offstage wait');
      break;
    }
  }
  assert.ok(sawDelivery && sawReverse && sawHiddenGap && sawNextDelivery);
});

test('putaway steers through staging while moving and lines up straight for each floor pickup', () => {
  const simulation = createSimulation();
  const staging = simulation.layout.staging;
  let before = simulation.step(simulation.introDuration);
  let reverseSteering = false, forwardSteering = false, pickups = 0;
  for (let time = 0; time < 180; time += 0.05) {
    const state = simulation.step(0.05), truck = state.forklift;
    const previous = before.forklift;
    const turned = angleDistance(previous.yaw, truck.yaw);
    const moved = Math.hypot(truck.position.x - previous.position.x, truck.position.z - previous.position.z);
    const nearStaging = Math.abs(truck.position.x - staging.x) < 2.1 && truck.position.z < -24.5;
    if (nearStaging && turned > 1e-5) {
      assert.ok(moved > 1e-6, 'the truck must steer along a moving path instead of spinning beside the floor pallet');
      if (truck.speed < -0.01) reverseSteering = true;
      if (truck.speed > 0.01) forwardSteering = true;
    }
    if (truck.action === 'insert' && !truck.cargoId && truck.position.z < -25 && Math.abs(truck.position.x - staging.x) < 0.01) {
      close(truck.position.x, staging.x, 'pickup aligns with the staging centre');
      close(angleDistance(truck.yaw, Math.PI), 0, 'forks face straight toward the floor pallet');
      assert.ok(truck.speed >= 0, 'approach drives forward into the pallet');
    }
    if (truck.cargoId && !previous.cargoId) pickups++;
    before = state;
  }
  assert.ok(pickups >= 3, 'check several staging visits');
  assert.ok(reverseSteering && forwardSteering, 'staging uses a real reverse departure and forward return curve');
});

test('forklift telemetry describes real signed motion and hydraulic travel independently', () => {
  const simulation = createSimulation();
  const epsilon = 1e-4;
  const seen = new Set();
  let previousRunning = [false, false, false];
  const runningSince = [0, 0, 0];
  function inspectMotion() {
    for (let time = 0; time < 180; time += 0.25) {
    const before = simulation.getState();
    const after = simulation.step(epsilon);
    before.forklifts.forEach((truck, i) => {
      assert.equal(typeof truck.engineRunning, 'boolean');
      assert.ok(Number.isFinite(truck.speed) && Number.isFinite(truck.liftVelocity));
      const next = after.forklifts[i];
      const actualSpeed = ((next.position.x - truck.position.x) * Math.sin(truck.yaw) + (next.position.z - truck.position.z) * Math.cos(truck.yaw)) / epsilon;
      const actualLift = (next.liftHeight - truck.liftHeight) / epsilon;
      assert.ok(Math.abs(truck.speed - actualSpeed) < 0.012, `${truck.role} speed follows the pose derivative`);
      assert.ok(Math.abs(truck.liftVelocity - actualLift) < 0.012, `${truck.role} hydraulics follow the lift derivative`);
      if (truck.engineRunning && !previousRunning[i]) runningSince[i] = time;
      if (Math.abs(truck.speed) > 0.01 || Math.abs(truck.liftVelocity) > 0.01) {
        assert.ok(truck.engineRunning, 'working trucks have running engines');
        assert.ok(time - runningSince[i] >= 2.1, 'startup sound has time before powered work');
      }
      if (truck.speed < -0.01) seen.add(`${truck.role}:reverse`);
      if (truck.speed > 0.01) seen.add(`${truck.role}:forward`);
      if (truck.liftVelocity > 0.01) seen.add(`${truck.role}:raise`);
      if (truck.liftVelocity < -0.01) seen.add(`${truck.role}:lower`);
      previousRunning[i] = truck.engineRunning;
    });
      simulation.step(0.25 - epsilon);
    }
  }
  inspectMotion();
  while (!simulation.getState().forklifts[1].visible) simulation.step(1);
  previousRunning = simulation.getState().forklifts.map(truck => truck.engineRunning);
  runningSince.fill(-Infinity);
  inspectMotion();
  for (const role of ['putaway', 'inbound', 'outbound']) {
    for (const motion of ['reverse', 'forward', 'raise', 'lower']) assert.ok(seen.has(`${role}:${motion}`));
  }
});

test('two complete cycles feed one floor box, store all cells once in order and ship FIFO while putaway continues', { timeout: 30000 }, () => {
  const simulation = createSimulation();
  const ids = simulation.getState().boxes.map(box => box.id);
  const stored = [[], []], shipped = [[], []];
  const previousKinds = ids.map(() => 'pending');
  let previousCycle = 0, sawParallel = false, sawDescent = false;
  for (let time = 0; time < (simulation.introDuration || 0) + simulation.cycleDuration * 2 + 1; time += 0.5) {
    const state = simulation.getState();
    if (state.cycle === 2) break;
    if (state.cycle !== previousCycle) previousKinds.fill('pending');
    if (time >= (simulation.introDuration || 0)) assert.equal(state.forklift.position.y, 0, 'putaway stays on the floor after its one-time entry');
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
  const gateStates = { in: new Set(), out: new Set() };
  const rackRectangles = simulation.layout.racks.map(rack => rectangle({ x: rack.x, z: rack.z }, 0, rack.width / 2, -rack.depth / 2, rack.depth / 2));
  while (previous.cycle === 0) {
    const state = simulation.step(dt);
    // Bounds include the actual normalized GLB body (width1.34, rear-1.78),
    // not only the previous procedural truck's smaller chassis.
    const bodies = state.forklifts.map(truck => rectangle(truck.position, truck.yaw, 0.7, -1.8, 0.9));
    for (const key of ['in', 'out']) {
      const openness = state.gates?.[key];
      assert.ok(Number.isFinite(openness) && openness >= 0 && openness <= 1, 'gate openness is normalized');
      assert.ok(Math.abs(openness - previous.gates[key]) <= 1.26 * dt, 'gate panels animate continuously');
      gateStates[key].add(openness === 0 ? 'closed' : openness === 1 ? 'open' : 'moving');
    }
    state.forklifts.forEach((truck, i) => {
      actions.add(truck.action);
      const before = previous.forklifts[i];
      assert.ok(distance(before.position, truck.position) <= 6.8 * dt + 1e-7, `${truck.role} never teleports`);
      assert.ok(angleDistance(before.yaw, truck.yaw) <= 2.11 * dt + 1e-7, `${truck.role} never snaps its heading`);
      assert.ok(Math.abs(before.liftHeight - truck.liftHeight) <= 1.21 * dt + 1e-7, `${truck.role} lift stays continuous`);
      if (!truck.visible || truck.position.y > 10.5) return;
      if (truck.role === 'inbound' || truck.role === 'outbound') {
        const fullFootprint = rectangle(truck.position, truck.yaw, 0.7, -1.8, 2.25);
        const zValues = fullFootprint.map(point => point.z);
        if (Math.min(...zValues) <= -34.8 && Math.max(...zValues) >= -35.2) {
          assert.equal(state.gates[truck.role === 'inbound' ? 'in' : 'out'], 1, 'gate stays fully open while body, forks or cargo cross its thickness');
        }
      }
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
  for (const key of ['in', 'out']) assert.deepEqual([...gateStates[key]].sort(), ['closed', 'moving', 'open']);
});

test('snapshots are isolated, invalid time has no effect, and disposing freezes the simulation', () => {
  const simulation = createSimulation();
  const before = simulation.getState(), changed = simulation.getState();
  changed.boxes[0].position.x = 12345;
  changed.boxes[0].location.kind = 'carried';
  changed.forklifts[0].position.z = -12345;
  changed.forklift.position.x = -12345;
  if (changed.gates) changed.gates.in = 12345;
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
  const elapsed = (one.introDuration || 0) + one.cycleDuration * 2.25;
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
    close(truck.speed, split.forklifts[i].speed, 'partitioned speed');
    close(truck.liftVelocity, split.forklifts[i].liftVelocity, 'partitioned hydraulic speed');
    assert.equal(truck.engineRunning, split.forklifts[i].engineRunning);
  });
  for (const key of ['in', 'out']) close(once.gates[key], split.gates[key], 'partitioned gate');
  once.boxes.forEach((box, i) => {
    assert.deepEqual(box.location, split.boxes[i].location);
    assert.ok(distance(box.position, split.boxes[i].position) < 1e-7);
  });
  const enormous = one.step(Number.MAX_VALUE);
  assert.ok(Number.isFinite(enormous.cycle) && enormous.cycle > once.cycle);
  for (const truck of enormous.forklifts) assert.ok([...Object.values(truck.position), truck.yaw, truck.liftHeight].every(Number.isFinite));
});
