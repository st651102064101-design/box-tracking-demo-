import assert from 'node:assert/strict';
import { createSimulation } from '../public/warehouse-simulation-engine.mjs';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-7, `${message}: ${a} versus ${b}`);

test('paired racks begin with five full racks, one empty and all vehicles on the ground', () => {
  const simulation = createSimulation(), state = simulation.getState();
  assert.equal(simulation.layout.racks.length, 6);
  for (let i = 0; i < 6; i += 2) {
    const [a, b] = simulation.layout.racks.slice(i, i + 2);
    assert.equal(a.facing, -1); assert.equal(b.facing, 1);
    close(b.z - a.z - a.depth, 0.18, 'back-to-back spacer gap');
    assert.ok(a.depth <= 1.25, 'pallets fill the shelf depth');
  }
  assert.equal(state.boxes.filter(box => box.location.kind === 'rack').length, 250);
  assert.deepEqual(Array.from({ length: 6 }, (_, rack) => state.boxes.filter(box => box.location.rack === rack).length), [0, 50, 50, 50, 50, 50]);
  assert.equal(simulation.introDuration, 0);
  assert.ok(state.forklifts.every(truck => truck.position.y === 0));
  assert.equal(state.forklifts[1].visible, true);
  assert.equal(state.forklifts[2].engineRunning, true);
});

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

test('stable identities and immediate ground startup survive loop boundaries', () => {
  const simulation = createSimulation(), initial = simulation.getState();
  assert.equal(initial.boxes.length, 300);
  assert.equal(new Set(initial.boxes.map(box => box.id)).size, 300);
  assert.equal(simulation.layout.floorPositions.length, 1);
  assert.deepEqual(simulation.layout.staging, { x: -12, y: 0, z: -29 });
  assert.deepEqual(initial.forklifts.map(truck => truck.role), ['putaway', 'outbound', 'inbound']);
  assert.equal(initial.storedCount, 250); assert.equal(initial.shippedCount, 0);
  for (let t = 0; t < simulation.cycleDuration + 1; t += 1) {
    const state = simulation.step(1);
    assert.ok(state.forklifts.every(truck => truck.position.y === 0));
    assert.ok(state.forklifts.every(truck => !['ascend', 'descend'].includes(truck.action)));
  }
  assert.equal(simulation.getState().cycle, 1);
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

test('two cycles fill the one empty rack and ship preloaded stock before incoming loads', { timeout: 30000 }, () => {
  const simulation = createSimulation(), initial = simulation.getState();
  const ids = initial.boxes.map(box => box.id);
  const order = [...ids.slice(50), ...ids.slice(0, 50)];
  const stored = [ids.slice(50), ids.slice(50)], shipped = [[], []];
  let previousKinds = initial.boxes.map(box => box.location.kind), previousCycle = 0, sawParallel = false;
  for (let t = 0; t < simulation.cycleDuration * 2 + 1; t += 1) {
    const state = simulation.getState();
    if (state.cycle === 2) break;
    if (state.cycle !== previousCycle) previousKinds = initial.boxes.map(box => box.location.kind);
    previousCycle = state.cycle;
    assert.equal(state.boxes.length, 300);
    assert.ok(state.boxes.filter(box => box.location.kind === 'floor').length <= 1);
    const cells = new Set();
    for (let index = 0; index < state.boxes.length; index++) {
      const box = state.boxes[index];
      if (box.location.kind === 'rack') {
        const cell = `${box.location.rack}:${box.location.shelf}:${box.location.slot}:${box.location.side}`;
        assert.ok(!cells.has(cell), 'one pallet per bay side'); cells.add(cell);
        if (previousKinds[index] !== 'rack') {
          assert.deepEqual(box.location, {kind:'rack', rack:Math.floor(index/50), shelf:Math.floor(index%50/10), slot:Math.floor(index%10/2), side:index%2});
          const rack = simulation.layout.racks[box.location.rack];
          close(box.position.z, rack.z, 'pallet centred on fitted shelf');
          close(rack.depth/2 - 0.065 - (box.position.z + 0.55 - rack.z), 0.005, 'rear gap is five millimetres');
          assert.equal(index, stored[state.cycle].length - 250, 'new boxes fill rack 1 in shelf/bay/side order');
          stored[state.cycle].push(box.id);
        }
      }
      if (box.location.kind === 'shipped' && previousKinds[index] !== 'shipped') {
        assert.equal(box.id, order[shipped[state.cycle].length], 'older stock leaves first through Gate Out');
        assert.equal(box.visible, false); shipped[state.cycle].push(box.id);
      }
      previousKinds[index] = box.location.kind;
    }
    if (state.storedCount < 300 && state.forklifts[1].cargoId) sawParallel = true;
    assert.equal(state.storedCount, stored[state.cycle].length);
    assert.equal(state.shippedCount, shipped[state.cycle].length);
    simulation.step(1);
  }
  assert.equal(simulation.getState().cycle, 2);
  for (const entries of [...stored, ...shipped]) assert.deepEqual(entries, order);
  assert.ok(sawParallel, 'outbound starts immediately while the empty rack is filled');
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
        const fullFootprint = rectangle(truck.position, truck.yaw, 0.7, -1.8, 2.4);
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
      close(box.position.x, truck.position.x + Math.sin(truck.yaw) * simulation.layout.forkOffset, 'fork X');
      close(box.position.z, truck.position.z + Math.cos(truck.yaw) * simulation.layout.forkOffset, 'fork Z');
      close(box.position.y, truck.position.y + truck.liftHeight, 'fork height');
    });
    previous = state;
  }
  for (const action of ['drive', 'turn', 'lift', 'insert', 'retract', 'pickup', 'place']) assert.ok(actions.has(action), `observable ${action}`);
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
  const moved = simulation.step(3);
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
