// Metres and seconds. All identities, scheduling and poses belong to this pure
// module: no renderer, browser, storage, real inventory or network dependencies.
const FORWARD_OFFSET = 1.55;
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
const BOX_COUNT = 250;
const location = (kind, extra = {}) => ({ kind, rack: null, shelf: null, slot: null, side: null, ...extra });

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

function createLayout() {
  const staging = { x: -12, y: 0, z: -29 };
  return freeze({
    racks: [-22, -11, 0, 11, 22].map((z, i) => ({
      id: `simulation-rack-${i + 1}`, x: 0, z, width: 16, depth: 2,
      shelfHeights: [0.55, 2.65, 4.75, 6.85, 8.95],
      slotCenters: [-6.4, -3.2, 0, 3.2, 6.4],
    })),
    floorPositions: [staging], staging,
    gateIn: { x: -12, y: 0, z: -35 },
    inboundOffstage: { x: -12, y: 0, z: -40 },
    gateOut: { x: 13, y: 0, z: -35 },
    floorBounds: { minX: -20, maxX: 20, minZ: -35, maxZ: 35 },
  });
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

function createIntro() {
  // This left hoist bay is clear of the warehouse roof, lights and trusses.
  // Entry is not part of the repeating cycle: truck 1 remains on the floor.
  const putaway = track('simulation-forklift-1', 'putaway', { x: -17, y: 14, z: -29 }, 0);
  putaway.animate('descend', 10, { position: { x: -17, y: 0, z: -29 } });
  putaway.startEngine();
  putaway.travel(-17, -25);
  putaway.travel(-12, -25);
  putaway.turn(Math.PI);
  return putaway;
}

function berth(layout, index) {
  const rackIndex = Math.floor(index / 50), shelf = Math.floor(index % 50 / 10);
  const slot = Math.floor(index % 10 / 2), side = index % 2;
  const rack = layout.racks[rackIndex];
  return {
    // Keep the complete GLB mast and telescoping rails outside the front beam,
    // not just the chassis. The pallet sits over the front shelf supports while
    // the truck docks 2.20m ahead of the rack centre (0.65 + fork offset1.55).
    position: { x: rack.slotCenters[slot] + (side ? 0.7 : -0.7), y: rack.shelfHeights[shelf], z: rack.z - 0.65 },
    aisleZ: rack.z - 4.3,
    location: location('rack', { rack: rackIndex, shelf, slot, side }),
  };
}

function createTimeline(layout) {
  const putaway = track('simulation-forklift-1', 'putaway', { x: -12, y: 0, z: -25 }, Math.PI);
  const outbound = track('simulation-forklift-2', 'outbound', { x: 17, y: 14, z: -29 }, 0, false);
  const inbound = track('simulation-forklift-3', 'inbound', layout.inboundOffstage, 0, false);
  const trucks = [putaway, outbound, inbound];
  const boxes = Array.from({ length: BOX_COUNT }, (_, i) => ({
    id: `simulation-box-${String(i + 1).padStart(3, '0')}`,
    events: [{ start: 0, visible: false, position: { ...layout.gateIn }, rotationY: 0, location: location('pending') }],
  }));
  const storedTimes = [], shippedTimes = [], rackClearTimes = [];
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
  putaway.startEngine();
  for (let index = 0; index < BOX_COUNT; index++) {
    const box = boxes[index], target = berth(layout, index);
    inbound.waitUntil(index === 0 ? 0.6 : storedTimes[index - 1]);
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
    putaway.drive(layout.staging.x, layout.staging.z + FORWARD_OFFSET + 1, 'retract');
    putaway.lift(TRANSPORT_HEIGHT);
    putaway.steer(-Math.PI, STAGING_TURN_RADIUS, -1);
    putaway.travel(PUTAWAY_LANE_X, target.aisleZ);
    putaway.travel(target.position.x, target.aisleZ);
    putaway.turn(0);
    putaway.lift(target.position.y + SHELF_CLEARANCE);
    putaway.drive(target.position.x, target.position.z - FORWARD_OFFSET, 'insert');
    putaway.lift(target.position.y);
    storedTimes.push(putaway.time);
    release(box, putaway, target.location, target.position, putawayRotationOffset);
    putaway.drive(target.position.x, target.aisleZ, 'retract');
    putaway.lift(TRANSPORT_HEIGHT);
    putaway.travel(PUTAWAY_LANE_X, target.aisleZ);
    // Rack-wide reservation: outbound enters a row only after its fiftieth
    // placement and after truck 1 clears that row onto the left travel lane.
    if (index % 50 === 49) rackClearTimes.push(putaway.time);
    // Empty return keeps its heading while reversing down the left lane,
    // then steers forward into the pickup line without pivoting at the box.
    putaway.turn(0);
    putaway.drive(PUTAWAY_LANE_X, -25, target.aisleZ > -25 ? 'retract' : 'drive');
    putaway.steer(Math.PI, STAGING_TURN_RADIUS);
  }
  putaway.pose.engineRunning = false;

  outbound.waitUntil(storedTimes[49]);
  outbound.pose.visible = true;
  outbound.animate('descend', 10, { position: { x: 17, y: 0, z: -29 } });
  outbound.startEngine();
  outbound.travel(13, -29);
  for (let index = 0; index < BOX_COUNT; index++) {
    const box = boxes[index], source = berth(layout, index);
    outbound.travel(13, source.aisleZ);
    outbound.waitUntil(rackClearTimes[source.location.rack]);
    outbound.travel(source.position.x, source.aisleZ);
    outbound.turn(0);
    outbound.lift(source.position.y);
    outbound.drive(source.position.x, source.position.z - FORWARD_OFFSET, 'insert');
    carry(box, outbound, -Math.PI);
    outbound.lift(source.position.y + SHELF_CLEARANCE);
    outbound.drive(source.position.x, source.aisleZ, 'retract');
    outbound.lift(TRANSPORT_HEIGHT);
    outbound.travel(13, source.aisleZ);
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
  outbound.travel(17, -29);
  outbound.turn(0);
  outbound.pose.engineRunning = false;
  outbound.animate('ascend', 10, { position: { x: 17, y: 14, z: -29 } });
  outbound.pose.visible = false;
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
  const layout = createLayout(), timeline = createTimeline(layout), intro = createIntro();
  let elapsed = 0, introElapsed = 0, cycle = 0, disposed = false;

  function getState() {
    const forklifts = timeline.trucks.map(truck => poseAt(truck, elapsed));
    if (introElapsed < intro.time) forklifts[0] = poseAt(intro, introElapsed);
    const storedCount = countAt(timeline.storedTimes, elapsed);
    const shippedCount = countAt(timeline.shippedTimes, elapsed);
    const phase = shippedCount === BOX_COUNT ? 'returning' : storedCount === BOX_COUNT ? 'shipping' : storedCount >= 50 ? 'parallel' : 'filling';
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
      const introStep = Math.min(deltaSeconds, intro.time - introElapsed);
      introElapsed += introStep;
      deltaSeconds -= introStep;
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

  // Total elapsed time at cycle N is introDuration + N * cycleDuration. The
  // introductory descent runs only once and arbitrary deltas can skip it.
  return { layout, introDuration: intro.time, cycleDuration: timeline.duration, getState, step, dispose() { disposed = true; } };
}
