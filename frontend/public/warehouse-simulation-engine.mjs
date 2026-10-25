// Metres and seconds. All identities, scheduling and poses belong to this pure
// module: no renderer, browser, storage, real inventory or network dependencies.
const FORWARD_OFFSET = 1.8;
const TRANSPORT_HEIGHT = 0.28;
const SHELF_CLEARANCE = 0.16;
const DRIVE_SPEED = 4.5;
const DOCK_SPEED = 1.1;
const TURN_SPEED = 1.4;
const LIFT_SPEED = 0.8;
const ENGINE_START_DURATION = 2.4;
const GATE_DURATION = 1.2;
const STAGING_TURN_RADIUS = 2;
const PUTAWAY_LANE_X = -16;
const FRONT_CROSS_AISLE_Z = -16;
const PAIR_AISLE_WIDTH = 5.6;
const BOX_COUNT = 300;
const INCOMING_COUNT = 50;
const location = (kind, extra = {}) => ({ kind, rack: null, shelf: null, slot: null, side: null, ...extra });

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

function createLayout() {
  const staging = { x: -12, y: 0, z: -29 };
  const rackDepth = 1.24, beamDepth = 0.13;
  const halfPairOffset = (rackDepth + 0.18) / 2;
  const pairPitch = 2 * rackDepth + 0.18 + beamDepth + PAIR_AISLE_WIDTH;
  return freeze({
    // Three compact longitudinal pairs. The 18cm rear spacer is separate
    // from the 5.6m clear aisle between their outward-facing fronts.
    racks: Array.from({ length: 6 }, (_, i) => ({
      id: `simulation-rack-${i + 1}`,
      x: (Math.floor(i / 2) - 1) * pairPitch + (i % 2 ? halfPairOffset : -halfPairOffset),
      z: 0, width: 16, depth: rackDepth, beamDepth,
      rotationY: -Math.PI / 2, facing: i % 2 ? -1 : 1,
      shelfHeights: [0.55, 2.65, 4.75, 6.85, 8.95],
      slotCenters: [-6.4, -3.2, 0, 3.2, 6.4],
    })),
    floorPositions: [staging], staging, forkOffset: FORWARD_OFFSET,
    pairAisleWidth: PAIR_AISLE_WIDTH, crossAisleZ: FRONT_CROSS_AISLE_Z,
    gateIn: { x: -12, y: 0, z: -35 },
    inboundOffstage: { x: -12, y: 0, z: -40 },
    gateOut: { x: 13, y: 0, z: -35 },
    floorBounds: { minX: -20, maxX: 20, minZ: -35, maxZ: 35 },
  });
}

// Rack graphics, cargo and docking all use the same local frame: along the
// five bays, vertically up, and across the shelf depth toward its front.
export function rackPoint(rack, along, height = 0, across = 0) {
  const cosine = Math.cos(rack.rotationY), sine = Math.sin(rack.rotationY);
  return { x: rack.x + along * cosine + across * sine, y: height, z: rack.z - along * sine + across * cosine };
}

const clonePose = pose => ({ ...pose, position: { ...pose.position } });

// Each segment stores just one truck's pose, never a 250-box scene snapshot.
// Waiting and motion share the same track so evaluating a time is a binary search.
function track(id, role, position, yaw, visible = true) {
  const vehicle = {
    id, role, time: 0, segments: [],
    pose: { position: { ...position }, yaw, liftHeight: TRANSPORT_HEIGHT, cargoId: null, visible, engineRunning: false },
  };
  vehicle.animate = (action, seconds, changes = {}, curve = null) => {
    if (seconds <= 1e-10) return;
    const from = clonePose(vehicle.pose);
    const to = clonePose({ ...vehicle.pose, ...changes });
    vehicle.segments.push({ start: vehicle.time, duration: seconds, action, from, to, curve });
    vehicle.time += seconds;
    // Later heading normalization and cargo events must not mutate a recorded
    // segment endpoint: a normalized angle can differ by a complete revolution.
    vehicle.pose = clonePose(to);
  };
  vehicle.waitUntil = time => vehicle.animate('wait', Math.max(0, time - vehicle.time));
  vehicle.turn = yaw => {
    const difference = Math.atan2(Math.sin(yaw - vehicle.pose.yaw), Math.cos(yaw - vehicle.pose.yaw));
    vehicle.animate('turn', Math.abs(difference) / TURN_SPEED, { yaw: vehicle.pose.yaw + difference });
    vehicle.pose.yaw = yaw;
  };
  vehicle.drive = (x, z, action = 'drive') => {
    const distance = Math.hypot(x - vehicle.pose.position.x, z - vehicle.pose.position.z);
    vehicle.animate(action, distance / (action === 'drive' ? DRIVE_SPEED : DOCK_SPEED), {
      position: { x, y: vehicle.pose.position.y, z },
    });
  };
  vehicle.travel = (x, z) => {
    const dx = x - vehicle.pose.position.x, dz = z - vehicle.pose.position.z;
    if (Math.hypot(dx, dz) < 1e-10) return;
    vehicle.turn(Math.atan2(dx, dz));
    vehicle.drive(x, z);
  };
  vehicle.steer = (yawChange, radius, direction = 1) => {
    const fromYaw = vehicle.pose.yaw, toYaw = fromYaw + yawChange;
    const scale = direction * radius * Math.sign(yawChange);
    vehicle.animate('steer', radius * Math.abs(yawChange) / DOCK_SPEED, {
      yaw: toYaw,
      position: {
        x: vehicle.pose.position.x + scale * (Math.cos(fromYaw) - Math.cos(toYaw)),
        y: vehicle.pose.position.y,
        z: vehicle.pose.position.z + scale * (Math.sin(toYaw) - Math.sin(fromYaw)),
      },
    }, { radius, direction, scale });
  };
  vehicle.lift = height => vehicle.animate('lift', Math.abs(height - vehicle.pose.liftHeight) / LIFT_SPEED, { liftHeight: height });
  vehicle.startEngine = () => {
    vehicle.pose.engineRunning = true;
    vehicle.animate('engine-start', ENGINE_START_DURATION);
  };
  return vehicle;
}

function berth(layout, index) {
  const rackIndex = Math.floor(index / 50), shelf = Math.floor(index % 50 / 10);
  const slot = Math.floor(index % 10 / 2), side = index % 2;
  const rack = layout.racks[rackIndex];
  const along = rack.slotCenters[slot] + (side ? 0.7 : -0.7);
  return {
    // Centre the 1.10m pallet on the 1.24m shelf. The longer fork offset leaves
    // the real GLB mast clear of the beam on either face of a paired row.
    position: rackPoint(rack, along, rack.shelfHeights[shelf]),
    aisle: rackPoint(rack, along, 0, rack.facing * ((rack.depth + rack.beamDepth) / 2 + PAIR_AISLE_WIDTH / 2)),
    dock: rackPoint(rack, along, 0, rack.facing * FORWARD_OFFSET),
    yaw: rack.rotationY + (rack.facing === -1 ? 0 : Math.PI),
    location: location('rack', { rack: rackIndex, shelf, slot, side }),
  };
}

function createTimeline(layout) {
  const putaway = track('simulation-forklift-1', 'putaway', { x: -12, y: 0, z: -25 }, Math.PI);
  const outbound = track('simulation-forklift-2', 'outbound', { x: 13, y: 0, z: -29 }, Math.PI);
  const inbound = track('simulation-forklift-3', 'inbound', layout.inboundOffstage, 0);
  const trucks = [putaway, outbound, inbound];
  const boxes = Array.from({ length: BOX_COUNT }, (_, i) => {
    const target = i >= INCOMING_COUNT ? berth(layout, i) : null;
    return {
      id: `simulation-box-${String(i + 1).padStart(3, '0')}`,
      events: [{ start: 0, visible: Boolean(target), position: { ...(target?.position || layout.gateIn) },
        rotationY: target ? target.yaw - Math.PI : 0, location: target?.location || location('pending') }],
    };
  });
  const storedTimes = Array(BOX_COUNT - INCOMING_COUNT).fill(0), placementTimes = [], shippedTimes = [];
  const rackClearTimes = Array(layout.racks.length).fill(0);
  const gates = { in: [], out: [] };

  function openGate(key, truck) {
    const start = truck.time;
    // Complete opening before any part of the approaching truck or load can
    // touch the portal. Its entire journey holds the gate open thereafter.
    truck.animate('gate-wait', GATE_DURATION);
    return start;
  }

  function closeGate(key, start, truck) {
    const intervals = gates[key];
    const previous = intervals.at(-1);
    if (previous && start <= previous.closeStart + GATE_DURATION) previous.closeStart = truck.time;
    else intervals.push({ start, closeStart: truck.time });
  }

  function carry(box, truck, rotationOffset) {
    truck.pose.cargoId = box.id;
    box.events.push({
      start: truck.time, visible: true, truckIndex: trucks.indexOf(truck), rotationOffset,
      location: location('carried', { forkliftId: truck.id }),
    });
    truck.animate('pickup', 0.35);
  }

  function release(box, truck, boxLocation, position, rotationY, visible = true) {
    truck.pose.cargoId = null;
    box.events.push({ start: truck.time, location: boxLocation, position: { ...position }, rotationY, visible });
    truck.animate('place', 0.35);
  }

  // The next inbound journey is released only by the prior storage event.
  // Truck 1 cannot approach staging until truck 3 has completely backed out.
  const stagingTurnZ = -25;
  putaway.startEngine();
  for (let index = 0; index < INCOMING_COUNT; index++) {
    const box = boxes[index], target = berth(layout, index);
    inbound.waitUntil(index === 0 ? 0 : placementTimes[index - 1]);
    inbound.startEngine();
    inbound.pose.visible = true;
    carry(box, inbound, 0);
    const gateInStart = openGate('in', inbound);
    inbound.drive(layout.staging.x, layout.staging.z - FORWARD_OFFSET, 'insert');
    inbound.lift(0);
    release(box, inbound, location('floor'), layout.staging, 0);
    inbound.drive(layout.inboundOffstage.x, layout.inboundOffstage.z, 'retract');
    inbound.lift(TRANSPORT_HEIGHT);
    closeGate('in', gateInStart, inbound);
    inbound.pose.visible = false;
    inbound.pose.engineRunning = false;

    putaway.waitUntil(inbound.time);
    putaway.lift(0);
    putaway.drive(layout.staging.x, layout.staging.z + FORWARD_OFFSET, 'insert');
    // The trucks face opposite directions at staging. Preserve the pallet's
    // actual rotation through handoff rather than snapping it through 180deg.
    const putawayRotationOffset = -Math.PI;
    carry(box, putaway, putawayRotationOffset);
    putaway.lift(SHELF_CLEARANCE);
    // Clear the pallet straight back before steering. The old one-metre lane
    // jog required three stationary pivots beside the staging point and looked
    // like circling; a reversing half-circle connects to the travel lane.
    putaway.drive(layout.staging.x, stagingTurnZ, 'retract');
    putaway.lift(TRANSPORT_HEIGHT);
    putaway.steer(-Math.PI, STAGING_TURN_RADIUS, -1);
    putaway.travel(PUTAWAY_LANE_X, layout.crossAisleZ);
    putaway.travel(target.aisle.x, layout.crossAisleZ);
    putaway.travel(target.aisle.x, target.aisle.z);
    putaway.turn(target.yaw);
    putaway.lift(target.position.y + SHELF_CLEARANCE);
    putaway.drive(target.dock.x, target.dock.z, 'insert');
    putaway.lift(target.position.y);
    storedTimes.push(putaway.time);
    placementTimes.push(putaway.time);
    release(box, putaway, target.location, target.position, target.yaw + putawayRotationOffset);
    putaway.drive(target.aisle.x, target.aisle.z, 'retract');
    putaway.lift(TRANSPORT_HEIGHT);
    putaway.travel(target.aisle.x, layout.crossAisleZ);
    putaway.travel(PUTAWAY_LANE_X, layout.crossAisleZ);
    // Rack-wide reservation: outbound enters a row only after its fiftieth
    // placement and after truck 1 clears that row onto the left travel lane.
    if (index % 50 === 49) rackClearTimes[target.location.rack] = putaway.time;
    // Empty return keeps its heading while reversing down the left lane,
    // then steers forward into the pickup line without pivoting at the box.
    putaway.turn(0);
    putaway.drive(PUTAWAY_LANE_X, stagingTurnZ, 'retract');
    putaway.steer(Math.PI, STAGING_TURN_RADIUS);
  }
  putaway.pose.engineRunning = false;

  outbound.startEngine();
  // Existing stock predates this cycle's inbound loads. Ship it immediately,
  // then empty rack 1 after putaway has filled and cleared that aisle.
  const shippingOrder = [...Array.from({ length: BOX_COUNT - INCOMING_COUNT }, (_, i) => i + INCOMING_COUNT),
    ...Array.from({ length: INCOMING_COUNT }, (_, i) => i)];
  for (const index of shippingOrder) {
    const box = boxes[index], source = berth(layout, index);
    outbound.waitUntil(rackClearTimes[source.location.rack]);
    outbound.travel(layout.gateOut.x, layout.crossAisleZ);
    outbound.travel(source.aisle.x, layout.crossAisleZ);
    outbound.travel(source.aisle.x, source.aisle.z);
    outbound.turn(source.yaw);
    outbound.lift(source.position.y);
    outbound.drive(source.dock.x, source.dock.z, 'insert');
    carry(box, outbound, -Math.PI);
    outbound.lift(source.position.y + SHELF_CLEARANCE);
    outbound.drive(source.aisle.x, source.aisle.z, 'retract');
    outbound.lift(TRANSPORT_HEIGHT);
    outbound.travel(source.aisle.x, layout.crossAisleZ);
    outbound.travel(layout.gateOut.x, layout.crossAisleZ);
    outbound.travel(13, -29);
    outbound.turn(Math.PI);
    const gateOutStart = openGate('out', outbound);
    outbound.drive(13, layout.gateOut.z + FORWARD_OFFSET, 'insert');
    outbound.lift(0);
    shippedTimes.push(outbound.time);
    release(box, outbound, location('shipped'), layout.gateOut, 0, false);
    outbound.drive(13, -29, 'retract');
    outbound.lift(TRANSPORT_HEIGHT);
    closeGate('out', gateOutStart, outbound);
  }
  outbound.turn(Math.PI);
  outbound.pose.engineRunning = false;
  const duration = Math.max(...trucks.map(truck => truck.time)) + 2;
  for (const truck of trucks) truck.waitUntil(duration);
  for (const box of boxes) box.events.sort((a, b) => a.start - b.start);
  return { trucks, boxes, gates, storedTimes, shippedTimes, duration };
}

// Last item at or before time. Every pose/event track has an entry at time 0.
function indexAt(items, time, getTime = item => item.start) {
  let low = 0, high = items.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (getTime(items[middle]) <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

function countAt(times, elapsed) {
  if (elapsed < times[0]) return 0;
  return indexAt(times, elapsed, value => value) + 1;
}

function poseAt(truck, elapsed) {
  const segment = truck.segments[indexAt(truck.segments, elapsed)];
  const progress = Math.max(0, Math.min(1, (elapsed - segment.start) / segment.duration));
  const eased = progress * progress * (3 - 2 * progress);
  const velocityFactor = 6 * progress * (1 - progress) / segment.duration;
  const lerp = (a, b) => a + (b - a) * eased;
  const yaw = lerp(segment.from.yaw, segment.to.yaw);
  const position = segment.curve ? {
    x: segment.from.position.x + segment.curve.scale * (Math.cos(segment.from.yaw) - Math.cos(yaw)),
    y: lerp(segment.from.position.y, segment.to.position.y),
    z: segment.from.position.z + segment.curve.scale * (Math.sin(yaw) - Math.sin(segment.from.yaw)),
  } : Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, lerp(segment.from.position[axis], segment.to.position[axis])]));
  return {
    id: truck.id, role: truck.role, action: segment.action,
    visible: segment.from.visible, cargoId: segment.from.cargoId,
    position,
    yaw,
    liftHeight: lerp(segment.from.liftHeight, segment.to.liftHeight),
    speed: segment.curve
      ? segment.curve.direction * segment.curve.radius * Math.abs(segment.to.yaw - segment.from.yaw) * velocityFactor
      : velocityFactor * ((segment.to.position.x - segment.from.position.x) * Math.sin(yaw) + (segment.to.position.z - segment.from.position.z) * Math.cos(yaw)),
    liftVelocity: velocityFactor * (segment.to.liftHeight - segment.from.liftHeight),
    engineRunning: segment.from.engineRunning,
  };
}

function gateAt(intervals, elapsed) {
  if (!intervals.length || elapsed < intervals[0].start) return 0;
  const interval = intervals[indexAt(intervals, elapsed)];
  const progress = Math.max(0, Math.min(1, elapsed < interval.start + GATE_DURATION
    ? (elapsed - interval.start) / GATE_DURATION
    : 1 - (elapsed - interval.closeStart) / GATE_DURATION));
  return progress * progress * (3 - 2 * progress);
}

export function createSimulation() {
  const layout = createLayout(), timeline = createTimeline(layout);
  let elapsed = 0, cycle = 0, disposed = false;

  function getState() {
    const forklifts = timeline.trucks.map(truck => poseAt(truck, elapsed));
    const storedCount = countAt(timeline.storedTimes, elapsed);
    const shippedCount = countAt(timeline.shippedTimes, elapsed);
    const phase = shippedCount === BOX_COUNT ? 'returning' : storedCount === BOX_COUNT ? 'shipping' : 'parallel';
    return {
      cycle, phase, completedInPhase: phase === 'filling' ? storedCount : shippedCount,
      storedCount, shippedCount, action: forklifts[0].action,
      forklifts, forklift: forklifts[0],
      gates: { in: gateAt(timeline.gates.in, elapsed), out: gateAt(timeline.gates.out, elapsed) },
      boxes: timeline.boxes.map(box => {
        const event = box.events[indexAt(box.events, elapsed)];
        const truck = event.truckIndex === undefined ? null : forklifts[event.truckIndex];
        return {
          id: box.id, visible: event.visible, location: { ...event.location },
          position: truck ? {
            x: truck.position.x + Math.sin(truck.yaw) * FORWARD_OFFSET,
            y: truck.position.y + truck.liftHeight,
            z: truck.position.z + Math.cos(truck.yaw) * FORWARD_OFFSET,
          } : { ...event.position },
          rotationY: truck ? truck.yaw + event.rotationOffset : event.rotationY,
        };
      }),
    };
  }

  function step(deltaSeconds) {
    if (!disposed && Number.isFinite(deltaSeconds) && deltaSeconds > 0) {
      // Reduce before adding, including Number.MAX_VALUE: no catch-up loop,
      // overflow, dropped elapsed time, or dependence on previous frame size.
      cycle = Math.min(Number.MAX_VALUE, cycle + Math.floor(deltaSeconds / timeline.duration));
      elapsed += deltaSeconds % timeline.duration;
      if (elapsed >= timeline.duration) {
        elapsed -= timeline.duration;
        cycle = Math.min(Number.MAX_VALUE, cycle + 1);
      }
    }
    return getState();
  }

  return { layout, introDuration: 0, cycleDuration: timeline.duration, getState, step, dispose() { disposed = true; } };
}
