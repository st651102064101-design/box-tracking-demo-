// Coordinates are metres. The forklift faces +Z and its pallet centre is 1.55m
// forward of the origin. Only this module owns simulation identities and poses.
const FORWARD_OFFSET = 1.55;
const TRANSPORT_HEIGHT = 0.28;
const SHELF_CLEARANCE = 0.16;
const DRIVE_SPEED = 4.5;
const DOCK_SPEED = 1.1;
const TURN_SPEED = 1.4;
const LIFT_SPEED = 0.8;
const PHASES = ['floor-to-rack1', 'rack1-to-rack2', 'rack2-to-floor'];
const floorLocation = () => ({ kind: 'floor', rack: null, shelf: null, slot: null, side: null });

function freeze(value) {
  Object.values(value).forEach(child => {
    if (child && typeof child === 'object') freeze(child);
  });
  return Object.freeze(value);
}

function createLayout() {
  return freeze({
    racks: [-36, -18, 0, 18, 36].map((x, i) => ({
      id: `simulation-rack-${i + 1}`, x, z: 12, width: 16, depth: 2,
      shelfHeights: [0.55, 2.65, 4.75, 6.85, 8.95],
      slotCenters: [-6.4, -3.2, 0, 3.2, 6.4].map(offset => x + offset),
    })),
    floorPositions: Array.from({ length: 10 }, (_, i) => ({ x: -18 + 4 * i, y: 0, z: -10 })),
    floorBounds: { minX: -50, maxX: 50, minZ: -18, maxZ: 22 },
  });
}

function copyState(state) {
  return {
    phase: state.phase, completedInPhase: state.completedInPhase,
    cycle: state.cycle, action: state.action,
    forklift: { ...state.forklift, position: { ...state.forklift.position } },
    boxes: state.boxes.map(box => ({ ...box, position: { ...box.position }, location: { ...box.location } })),
  };
}

function updateCargo(state) {
  const { forklift } = state;
  if (forklift.cargoId === null) return;
  const box = state.boxes.find(item => item.id === forklift.cargoId);
  box.position = {
    x: forklift.position.x + Math.sin(forklift.yaw) * FORWARD_OFFSET,
    y: forklift.liftHeight,
    z: forklift.position.z + Math.cos(forklift.yaw) * FORWARD_OFFSET,
  };
  box.rotationY = forklift.yaw;
}

function berth(layout, index, rackIndex) {
  if (rackIndex === null) {
    return { position: layout.floorPositions[index], yaw: Math.PI, aisleZ: -4, location: floorLocation() };
  }
  const rack = layout.racks[rackIndex];
  const slot = Math.floor(index / 2);
  const side = index % 2;
  return {
    position: {
      x: rack.slotCenters[slot] + (side === 0 ? -0.7 : 0.7),
      y: rack.shelfHeights[0],
      // The pallet sits near the front so the mast and chassis never enter the rack.
      z: rack.z - rack.depth / 2 + 0.65,
    },
    yaw: 0, aisleZ: 6,
    location: { kind: 'rack', rack: rackIndex, shelf: 0, slot, side },
  };
}

// A cycle is a finite sequence of continuous poses with identical endpoints.
// Compile it once so arbitrarily large elapsed times take bounded work, without
// dropping elapsed seconds, an unbounded catch-up loop, or a visible reset.
function createTimeline(layout) {
  const state = {
    phase: PHASES[0], completedInPhase: 0, cycle: 0, action: 'turn',
    forklift: { position: { x: 18, y: 0, z: -4 }, yaw: Math.PI, liftHeight: TRANSPORT_HEIGHT, cargoId: null },
    boxes: layout.floorPositions.map((position, i) => ({
      id: `simulation-box-${String(i + 1).padStart(2, '0')}`,
      position: { ...position }, rotationY: Math.PI, location: floorLocation(),
    })),
  };
  const segments = [];
  let duration = 0;

  function animate(action, seconds, target = {}) {
    if (seconds < 1e-10) return;
    state.action = action;
    const start = copyState(state);
    const end = {
      position: { ...(target.position ?? state.forklift.position) },
      yaw: target.yaw ?? state.forklift.yaw,
      liftHeight: target.liftHeight ?? state.forklift.liftHeight,
    };
    segments.push({ start: duration, duration: seconds, state: start, target: end });
    duration += seconds;
    Object.assign(state.forklift, end);
    updateCargo(state);
  }

  function turn(yaw) {
    const difference = Math.atan2(Math.sin(yaw - state.forklift.yaw), Math.cos(yaw - state.forklift.yaw));
    animate('turn', Math.abs(difference) / TURN_SPEED, { yaw: state.forklift.yaw + difference });
    state.forklift.yaw = yaw;
    updateCargo(state);
  }

  function drive(x, z, action = 'drive') {
    const distance = Math.hypot(x - state.forklift.position.x, z - state.forklift.position.z);
    animate(action, distance / (action === 'drive' ? DRIVE_SPEED : DOCK_SPEED), { position: { x, y: 0, z } });
  }

  function travel(x, z) {
    const dx = x - state.forklift.position.x;
    const dz = z - state.forklift.position.z;
    if (Math.hypot(dx, dz) < 1e-10) return;
    turn(Math.atan2(dx, dz));
    drive(x, z);
  }

  function approach(destination) {
    travel(state.forklift.position.x, 0);
    travel(destination.position.x, 0);
    travel(destination.position.x, destination.aisleZ);
    turn(destination.yaw);
  }

  function lift(height) {
    animate('lift', Math.abs(height - state.forklift.liftHeight) / LIFT_SPEED, { liftHeight: height });
  }

  function insert(destination) {
    drive(
      destination.position.x - Math.sin(destination.yaw) * FORWARD_OFFSET,
      destination.position.z - Math.cos(destination.yaw) * FORWARD_OFFSET,
      'insert',
    );
  }

  for (let phase = 0; phase < 3; phase++) {
    state.phase = PHASES[phase];
    state.completedInPhase = 0;
    for (let index = 0; index < 10; index++) {
      const source = berth(layout, index, phase === 0 ? null : phase - 1);
      const destination = berth(layout, index, phase === 2 ? null : phase);
      const box = state.boxes[index];

      approach(source);
      lift(source.position.y);
      insert(source);
      state.forklift.cargoId = box.id;
      box.location = { kind: 'carried', rack: null, shelf: null, slot: null, side: null };
      updateCargo(state);
      animate('pickup', 0.3);
      lift(source.position.y + SHELF_CLEARANCE);
      drive(source.position.x, source.aisleZ, 'retract');
      lift(TRANSPORT_HEIGHT);

      approach(destination);
      lift(destination.position.y + SHELF_CLEARANCE);
      insert(destination);
      lift(destination.position.y);
      state.forklift.cargoId = null;
      box.position = { ...destination.position };
      box.rotationY = destination.yaw;
      box.location = { ...destination.location };
      state.completedInPhase++;
      animate('place', 0.3);
      // Forks stay level until completely clear of the shelf and pallet.
      drive(destination.position.x, destination.aisleZ, 'retract');
      lift(TRANSPORT_HEIGHT);
    }
  }
  return { segments, duration };
}

export function createSimulation() {
  const layout = createLayout();
  const timeline = createTimeline(layout);
  let elapsed = 0;
  let cycle = 0;
  let disposed = false;

  function getState() {
    let low = 0;
    let high = timeline.segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (timeline.segments[middle].start <= elapsed) low = middle;
      else high = middle - 1;
    }
    const segment = timeline.segments[low];
    const state = copyState(segment.state);
    const progress = Math.max(0, Math.min(1, (elapsed - segment.start) / segment.duration));
    const eased = progress * progress * (3 - 2 * progress);
    const interpolate = (a, b) => a + (b - a) * eased;
    for (const axis of ['x', 'y', 'z']) {
      state.forklift.position[axis] = interpolate(state.forklift.position[axis], segment.target.position[axis]);
    }
    state.forklift.yaw = interpolate(state.forklift.yaw, segment.target.yaw);
    state.forklift.liftHeight = interpolate(state.forklift.liftHeight, segment.target.liftHeight);
    state.cycle = cycle;
    updateCargo(state);
    return state;
  }

  function step(deltaSeconds) {
    if (!disposed && Number.isFinite(deltaSeconds) && deltaSeconds > 0) {
      // Reduce before adding: even Number.MAX_VALUE cannot overflow the clock.
      cycle = Math.min(Number.MAX_VALUE, cycle + Math.floor(deltaSeconds / timeline.duration));
      elapsed += deltaSeconds % timeline.duration;
      if (elapsed >= timeline.duration) {
        elapsed -= timeline.duration;
        cycle = Math.min(Number.MAX_VALUE, cycle + 1);
      }
    }
    return getState();
  }

  return { layout, getState, step, dispose() { disposed = true; } };
}
