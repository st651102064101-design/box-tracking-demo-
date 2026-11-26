/**
 * Turns "what the database said before" and "what it says now" into the work a
 * forklift can act out in the 3D view. Pure data: no scene, no network.
 */

/** More changes than this at once (an import, a long disconnect) are shown directly. */
export const MAX_ANIMATED_JOBS = 5;

/* Geometry only: a slot's box count and full/empty state change with every
   movement and must not count as a new layout. */
const layout = (model) => JSON.stringify([
  (model.racks || []).map((rack) => [
    rack.id, rack.positionCm, rack.rotationYDeg, rack.dimensionsCm,
    (rack.slots || []).map((slot) => [slot.id, slot.localPositionCm, slot.dimensionsCm]),
  ]),
  (model.doors || []).map((door) => [door.gateNo, door.type]),
]);

function places(model) {
  const map = new Map();
  (model.boxes || []).forEach((box) => map.set(String(box.id), { kind: 'slot', slotId: box.slotId, side: box.slotSide, box }));
  (model.stagingBoxes || []).forEach((box) => map.set(String(box.id), { kind: 'staging', box }));
  return map;
}

/** The door a movement most plausibly went through: the latest activity on a
 *  door of the right direction, else the first door that allows it. */
export function pickDoor(doors, way) {
  const usable = (doors || []).filter((door) => door.type === way || door.type === 'both');
  const active = usable.filter((door) => Number.isFinite(door.activityAgeMs))
    .sort((a, b) => a.activityAgeMs - b.activityAgeMs);
  return (active[0] || usable[0] || (doors || [])[0])?.gateNo ?? null;
}

const same = (a, b) => a.kind === b.kind && (a.kind !== 'slot' || (a.slotId === b.slotId && a.side === b.side));

/**
 * @returns the jobs in the order to play them, or null when the scene should
 * simply be rebuilt (racks or doors changed, or too much happened at once).
 */
export function planJobs(before, after) {
  if (layout(before) !== layout(after)) return null;
  const was = places(before);
  const now = places(after);
  const leaving = [];
  const moving = [];
  const arriving = [];
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const from = was.get(id);
    const to = now.get(id);
    if (from && !to) {
      leaving.push({ id, from, to: { kind: 'door', gateNo: pickDoor(after.doors, 'out') }, box: from.box });
    } else if (!from && to) {
      arriving.push({ id, from: { kind: 'door', gateNo: pickDoor(after.doors, 'in') }, to, box: to.box });
    } else if (!same(from, to)) {
      moving.push({ id, from, to, box: to.box });
    }
  }
  /* Departures first: they free the places that moves and arrivals go into. */
  const jobs = [...leaving, ...moving, ...arriving];
  return jobs.length > MAX_ANIMATED_JOBS ? null : jobs;
}

/** The inner rail must always stay this far inside the fixed mast. */
export const MAST_OVERLAP = 0.4;

/**
 * How high a two-stage mast can really go, from its parts' heights (metres):
 * the carriage climbs the inner rail first, then the rail slides up inside the
 * fixed mast and stops while the two still overlap.
 */
export function mastLimits({ carriageTop, innerBottom, innerTop, outerTop }) {
  const freeLift = Math.max(0, innerTop - carriageTop);
  const travel = Math.max(0, outerTop - MAST_OVERLAP - innerBottom);
  return { freeLift, travel, max: freeLift + travel };
}

export function mastPose(lift, limits) {
  const held = Math.min(limits.max, Math.max(0, lift));
  return { lift: held, inner: Math.max(0, held - limits.freeLift) };
}

/** A job waits while another box has still to be lifted out of its destination. */
export function canStart(job, unfinished) {
  if (job.to.kind !== 'slot') return true;
  return !unfinished.some((other) => other !== job && !other.picked
    && other.from.kind === 'slot' && other.from.slotId === job.to.slotId);
}

/** Closest two trucks' centres may come while one of them is still driving. */
export const TRUCK_SPACING = 2.4;

/** True when this step would take a truck closer to another that is too near. */
export function shouldYield(next, current, other) {
  const away = (p) => Math.hypot(p.x - other.x, p.z - other.z);
  return away(next) < TRUCK_SPACING && away(next) < away(current);
}

/** Bays side by side along z, centred on `base`. */
export function parkingBays(base, count, gap = 2.2) {
  return Array.from({ length: count }, (_, i) => ({ x: base.x, z: base.z + (i - (count - 1) / 2) * gap }));
}

/**
 * Where a truck stands to handle a load. A rack slot is only reachable from its
 * loading face (`face`, pointing out of the rack) — the other side is the back
 * of the neighbouring rack. A load on the floor is approached from the truck's
 * side. All points are floor coordinates {x, z}.
 */
export function standingPoints(centre, face, reach, truck) {
  let dx = face ? face.x : truck.x - centre.x;
  let dz = face ? face.z : truck.z - centre.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-3) { dx = 0; dz = 1; } else { dx /= length; dz /= length; }
  const out = (distance) => ({ x: centre.x + dx * distance, z: centre.z + dz * distance });
  return { normal: { x: dx, z: dz }, near: out(reach), before: out(reach + 1.3) };
}

/** Least distance between two parked trucks' centres. */
export const PARK_GAP = 1.8;

/** `at`, or the nearest place along the aisle (across `normal`) that no other
 *  truck is standing on. */
export function clearSpot(at, normal, others) {
  for (const step of [0, 1, -1, 2, -2, 3, -3]) {
    const spot = { x: at.x - normal.z * step * PARK_GAP, z: at.z + normal.x * step * PARK_GAP };
    if (others.every((o) => Math.hypot(spot.x - o.x, spot.z - o.z) >= PARK_GAP)) return step ? spot : at;
  }
  return at;
}

/* Sizes in metres. A selective-rack bay holds two pallets side by side. */
export const PALLET_HEIGHT = 0.15;
export const PALLET_WIDTH = 1.2; // along the beam
export const PALLET_DEPTH = 1.0;
export const BEAM_HALF = 0.0525; // a beam is centred on the slot's lower edge
const PALLET_CLEARANCE = 0.1; // between a pallet and the upright / its neighbour

/** Which half of the bay each box of one slot stands in: -1 left, 1 right. The
 *  recorded side is kept unless the other box already has it. */
export function palletSides(boxesInSlot) {
  const sides = new Map();
  const taken = new Set();
  [...boxesInSlot].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))
    .forEach((box) => {
      let side = box.slotSide === 'right' ? 1 : -1;
      if (taken.has(side) && !taken.has(-side)) side = -side;
      taken.add(side);
      sides.set(String(box.id), side);
    });
  return sides;
}

/**
 * Where a box and its pallet sit in a slot. `offset` is along the beam from the
 * slot's centre; `bottom` and `boxCentre` are heights above the slot's lower edge.
 */
export function palletFit(slot, side, box) {
  const half = slot.width / 2;
  const room = half - PALLET_CLEARANCE;
  const width = Math.min(room, Math.max(PALLET_WIDTH, box.width));
  const depth = Math.min(slot.depth, PALLET_DEPTH);
  return {
    offset: side * half / 2,
    width,
    depth,
    bottom: BEAM_HALF,
    boxCentre: BEAM_HALF + PALLET_HEIGHT + box.height / 2,
  };
}
