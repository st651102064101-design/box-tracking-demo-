import assert from 'node:assert/strict';
import { createSimulation } from '../public/warehouse-simulation-engine.mjs';

// Keep the standalone Node command while cooperating with the frontend runner.
const { test } = await import(process.env.VITEST ? 'vitest' : 'node:test');

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-8, `${message}: ${a} versus ${b}`);

test('initial model has ten unique floor pallets and five racks with five two-pallet bays per shelf', () => {
  const simulation = createSimulation();
  const state = simulation.getState();
  assert.equal(simulation.layout.racks.length, 5);
  assert.equal(simulation.layout.floorPositions.length, 10);
  assert.equal(state.boxes.length, 10);
  assert.equal(new Set(state.boxes.map(box => box.id)).size, 10);
  assert.equal(state.phase, 'floor-to-rack1');
  assert.equal(state.completedInPhase, 0);
  assert.equal(state.cycle, 0);
  assert.equal(state.forklift.cargoId, null);
  for (const rack of simulation.layout.racks) {
    assert.equal(rack.shelfHeights.length, 5);
    assert.equal(rack.slotCenters.length, 5);
    assert.ok(rack.depth >= 1.2);
    assert.ok(rack.shelfHeights.every((height, i, heights) => height > 0 && (!i || height - heights[i - 1] >= 1.5)));
    assert.ok(rack.slotCenters.every((x, i, xs) => x > rack.x - rack.width / 2 && x < rack.x + rack.width / 2 && (!i || x - xs[i - 1] >= 2.6)));
  }
  state.boxes.forEach((box, index) => {
    assert.deepEqual(box.position, simulation.layout.floorPositions[index]);
    assert.deepEqual(box.location, { kind: 'floor', rack: null, shelf: null, slot: null, side: null });
  });
});

test('snapshots cannot mutate the model, and idle time and disposal freeze its state', () => {
  const simulation = createSimulation();
  const before = simulation.getState();
  const changed = simulation.getState();
  changed.boxes[0].position.x = 12345;
  changed.boxes[0].location.kind = 'carried';
  changed.forklift.position.z = -12345;
  changed.phase = 'rack2-to-floor';
  assert.deepEqual(simulation.getState(), before);
  for (const dt of [0, -1, NaN, Infinity, -Infinity, undefined, null, '1']) {
    assert.deepEqual(simulation.step(dt), before);
  }
  const moving = simulation.step(2);
  assert.notDeepEqual(moving, before);
  moving.boxes.pop();
  assert.equal(simulation.getState().boxes.length, 10);
  const stopped = simulation.getState();
  simulation.dispose();
  simulation.dispose();
  assert.deepEqual(simulation.step(10000), stopped);
});

test('two complete cycles deliver individually, fill each slot in order, and restore the same floor identities', () => {
  const simulation = createSimulation();
  const initial = simulation.getState();
  const ids = initial.boxes.map(box => box.id);
  const deliveries = [];
  const phases = [];
  let previous = initial;
  for (let frame = 0; frame < 150000; frame++) {
    const state = simulation.step(0.2);
    assert.deepEqual(state.boxes.map(box => box.id), ids);
    assert.ok(state.completedInPhase >= 0 && state.completedInPhase <= 10);
    const carried = state.boxes.filter(box => box.location.kind === 'carried');
    assert.equal(carried.length, state.forklift.cargoId === null ? 0 : 1);
    if (carried.length) assert.equal(carried[0].id, state.forklift.cargoId);
    const occupancy = new Map();
    for (const box of state.boxes.filter(box => box.location.kind === 'rack')) {
      const { rack, shelf, slot, side } = box.location;
      assert.ok(rack === 0 || rack === 1, 'only the first two racks receive boxes');
      assert.equal(shelf, 0, 'ten boxes fit entirely on the bottom shelf');
      assert.ok(side === 0 || side === 1);
      const key = `${rack}:${shelf}:${slot}`;
      const sides = occupancy.get(key) ?? new Set();
      assert.ok(!sides.has(side), 'no two pallets own the same side of a slot');
      sides.add(side);
      occupancy.set(key, sides);
      assert.ok(sides.size <= 2);
    }
    if (previous.forklift.cargoId && !state.forklift.cargoId) {
      const index = deliveries.length % 10;
      const box = state.boxes.find(box => box.id === previous.forklift.cargoId);
      assert.equal(box.id, ids[index], 'every phase completes the ten transfers in order');
      if (state.phase === 'rack2-to-floor') {
        assert.deepEqual(box.position, initial.boxes[index].position);
        assert.deepEqual(box.location, initial.boxes[index].location);
        close(box.rotationY, initial.boxes[index].rotationY, 'floor orientation restored');
      } else {
        assert.deepEqual(box.location, {
          kind: 'rack', rack: state.phase === 'floor-to-rack1' ? 0 : 1,
          shelf: 0, slot: Math.floor(index / 2), side: index % 2,
        });
        close(box.position.y, simulation.layout.racks[box.location.rack].shelfHeights[0], 'pallet rests at shelf base');
      }
      assert.equal(state.completedInPhase, index + 1);
      deliveries.push(box.id);
    }
    if (state.phase !== previous.phase) {
      phases.push(state.phase);
      assert.equal(previous.completedInPhase, 10);
      assert.equal(state.completedInPhase, 0);
      assert.equal(state.forklift.cargoId, null);
      if (state.phase === 'floor-to-rack1') {
        state.boxes.forEach((box, i) => assert.deepEqual(box, initial.boxes[i]));
      } else {
        const rack = state.phase === 'rack1-to-rack2' ? 0 : 1;
        assert.ok(state.boxes.every(box => box.location.kind === 'rack' && box.location.rack === rack));
      }
    }
    previous = state;
    if (state.cycle >= 2) break;
  }
  assert.equal(previous.cycle, 2, 'two cycles finish without a reset');
  assert.equal(deliveries.length, 60);
  assert.deepEqual(phases, ['rack1-to-rack2', 'rack2-to-floor', 'floor-to-rack1', 'rack1-to-rack2', 'rack2-to-floor', 'floor-to-rack1']);
});

test('frame motion stays continuous through docking, turning, lifting and cycle wrap with exact fork attachment', () => {
  const simulation = createSimulation();
  let previous = simulation.getState();
  const actions = new Set();
  for (let frame = 0; frame < 150000; frame++) {
    const state = simulation.step(0.1);
    actions.add(state.action);
    assert.ok(distance(previous.forklift.position, state.forklift.position) <= 0.68, 'forklift never jumps');
    assert.ok(angleDistance(previous.forklift.yaw, state.forklift.yaw) <= 0.22, 'turn never snaps');
    assert.ok(Math.abs(previous.forklift.liftHeight - state.forklift.liftHeight) <= 0.13, 'lift never snaps');
    state.boxes.forEach((box, i) => {
      assert.ok(distance(previous.boxes[i].position, box.position) <= 0.7, `pallet ${box.id} never jumps`);
      assert.ok(angleDistance(previous.boxes[i].rotationY, box.rotationY) <= 0.22, 'pallet rotates continuously');
      if (box.location.kind === 'carried') {
        close(box.position.x, state.forklift.position.x + Math.sin(state.forklift.yaw) * 1.55, 'forward X offset');
        close(box.position.z, state.forklift.position.z + Math.cos(state.forklift.yaw) * 1.55, 'forward Z offset');
        close(box.position.y, state.forklift.liftHeight, 'fork and pallet height agree');
        if (state.action === 'retract' && box.position.z > 10.45) {
          assert.ok(box.position.y >= 0.71 - 1e-8, 'loaded forks clear the beam before lowering outside the rack');
        }
      }
      for (let j = 0; j < i; j++) {
        const other = state.boxes[j];
        assert.ok(Math.hypot(box.position.x - other.position.x, box.position.z - other.position.z) >= 1.2 - 1e-8, 'pallet footprints stay separated');
      }
    });
    const { x, z } = state.forklift.position;
    const { yaw } = state.forklift;
    for (const rack of simulation.layout.racks) {
      for (const localX of [-0.55, 0.55]) for (const localZ of [-1.2, 0.85]) {
        const worldX = x + localX * Math.cos(yaw) + localZ * Math.sin(yaw);
        const worldZ = z - localX * Math.sin(yaw) + localZ * Math.cos(yaw);
        assert.ok(worldX <= rack.x - rack.width / 2 || worldX >= rack.x + rack.width / 2 || worldZ <= rack.z - rack.depth / 2 || worldZ >= rack.z + rack.depth / 2, 'chassis stays outside rack volumes');
      }
    }
    for (const box of state.boxes.filter(box => box.location.kind === 'floor')) {
      const dx = box.position.x - x;
      const dz = box.position.z - z;
      const localX = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const localZ = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      assert.ok(Math.abs(localX) >= 1.15 || localZ <= -1.75 || localZ >= 1.4, 'chassis stays clear of staging pallets');
    }
    previous = state;
    if (state.cycle >= 1) break;
  }
  assert.equal(previous.cycle, 1);
  for (const action of ['drive', 'turn', 'lift', 'insert', 'retract', 'pickup', 'place']) assert.ok(actions.has(action), `visible ${action} action`);
});

test('large elapsed deltas are bounded work, account for cycles and agree with smaller steps', { timeout: 4000 }, () => {
  const one = createSimulation();
  const many = createSimulation();
  const once = one.step(20000);
  for (let i = 0; i < 20000; i++) many.step(1);
  const split = many.getState();
  assert.equal(once.cycle, split.cycle);
  assert.equal(once.phase, split.phase);
  assert.equal(once.completedInPhase, split.completedInPhase);
  assert.equal(once.forklift.cargoId, split.forklift.cargoId);
  assert.ok(distance(once.forklift.position, split.forklift.position) < 1e-7);
  close(once.forklift.liftHeight, split.forklift.liftHeight, 'delta partition lift');
  once.boxes.forEach((box, i) => assert.ok(distance(box.position, split.boxes[i].position) < 1e-7));
  const enormous = one.step(Number.MAX_VALUE);
  assert.ok(enormous.cycle > once.cycle);
  assert.ok(Number.isFinite(enormous.cycle));
  assert.ok(Object.values(enormous.forklift.position).every(Number.isFinite));
  assert.ok(Number.isFinite(enormous.forklift.yaw));
  assert.ok(Number.isFinite(enormous.forklift.liftHeight));
});
