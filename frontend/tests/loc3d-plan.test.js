import { describe, it, expect } from 'vitest';
import { planJobs, pickDoor, MAX_ANIMATED_JOBS, mastLimits, mastPose, canStart, shouldYield, parkingBays, standingPoints, clearSpot, PARK_GAP, palletSides, palletFit, BEAM_HALF, PALLET_HEIGHT } from '../public/loc3d-plan.js';

const doors = [{ gateNo: 1, type: 'in' }, { gateNo: 2, type: 'out' }, { gateNo: 3, type: 'both' }];
const scene = (boxes = [], stagingBoxes = [], extra = {}) => ({ racks: [{ id: 'r' }], doors, boxes, stagingBoxes, ...extra });
const at = (id, slotId, slotSide = 'left') => ({ id, slotId, slotSide });
const brief = (jobs) => jobs.map((j) => [j.id, j.from.kind, j.to.kind]);

describe('3D autopilot plan', () => {
  it('turns each database change into a job, departures first', () => {
    const before = scene([at('OUT', 's1'), at('MOVE', 's2'), at('SAME', 's3')], [{ id: 'WAIT' }]);
    const after = scene([at('MOVE', 's4'), at('SAME', 's3'), at('WAIT', 's1')], [{ id: 'NEW' }]);
    expect(brief(planJobs(before, after))).toEqual([
      ['OUT', 'slot', 'door'], ['MOVE', 'slot', 'slot'], ['WAIT', 'staging', 'slot'], ['NEW', 'door', 'staging'],
    ]);
  });

  it('has nothing to do when nothing moved', () => {
    expect(planJobs(scene([at('A', 's1')]), scene([at('A', 's1')]))).toEqual([]);
  });

  it('a slot filling or emptying is not a layout change', () => {
    const rack = (boxCount) => [{ id: 'r', slots: [{ id: 's1', boxCount, status: boxCount ? 'full' : 'empty' }] }];
    expect(planJobs(scene([], [], { racks: rack(0) }), scene([at('A', 's1')], [], { racks: rack(1) }))).toHaveLength(1);
  });

  it('shows large batches and layout changes directly', () => {
    const many = Array.from({ length: MAX_ANIMATED_JOBS + 1 }, (_, i) => at(`B${i}`, `s${i}`));
    expect(planJobs(scene(), scene(many))).toBeNull();
    expect(planJobs(scene(), scene([], [], { racks: [{ id: 'moved' }] }))).toBeNull();
  });

  it('uses the door where something just happened, in the right direction', () => {
    const active = [{ gateNo: 1, type: 'in', activityAgeMs: 100 }, { gateNo: 2, type: 'out' }, { gateNo: 3, type: 'both', activityAgeMs: 5000 }];
    expect(pickDoor(active, 'in')).toBe(1);
    expect(pickDoor(active, 'out')).toBe(3);
    expect(pickDoor([], 'out')).toBeNull();
  });
});

describe('forklift mast', () => {
  /* measured from the truck model, in metres */
  const parts = { carriageTop: 1.22, innerBottom: 0.11, innerTop: 2.40, outerTop: 2.35 };
  const limits = mastLimits(parts);

  it('never pulls the inner mast out of the outer one', () => {
    for (let lift = -1; lift <= 8; lift += 0.1) {
      const pose = mastPose(lift, limits);
      expect(pose.lift).toBeGreaterThanOrEqual(0);
      expect(pose.lift).toBeLessThanOrEqual(limits.max + 1e-9);
      expect(parts.outerTop - (parts.innerBottom + pose.inner)).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(parts.carriageTop + pose.lift).toBeLessThanOrEqual(parts.innerTop + pose.inner + 1e-9);
    }
  });

  it('reaches the second rack shelf (about 1.7 m)', () => {
    expect(limits.max).toBeGreaterThan(1.8);
    expect(limits.max).toBeLessThan(3.5);
  });
});

describe('two forklifts', () => {
  const slot = (slotId) => ({ kind: 'slot', slotId });
  const door = { kind: 'door' };

  it('does not put a box into a slot that has not been emptied yet', () => {
    const leave = { id: 'A', from: slot('s1'), to: door };
    const arrive = { id: 'B', from: door, to: slot('s1') };
    expect(canStart(arrive, [leave, arrive])).toBe(false);
    expect(canStart(leave, [leave, arrive])).toBe(true);
    leave.picked = true;
    expect(canStart(arrive, [leave, arrive])).toBe(true);
  });

  it('waits only when moving closer to a nearby truck', () => {
    const at = (x) => ({ x, z: 0 });
    expect(shouldYield(at(2.9), at(3.1), at(1))).toBe(true);
    expect(shouldYield(at(3.1), at(2.9), at(1))).toBe(false); // moving away
    expect(shouldYield(at(8), at(9), at(1))).toBe(false); // far
  });

  it('parks side by side without touching', () => {
    const [a, b] = parkingBays({ x: 10, z: 4 }, 2);
    expect(Math.abs(a.z - b.z)).toBeGreaterThanOrEqual(2);
    expect(a.x).toBe(b.x);
  });
});

describe('where a truck stands', () => {
  const slot = { x: -5.7, z: -1.3 };
  const outward = { x: -1, z: 0 };

  it('always uses the rack loading face, wherever the truck comes from', () => {
    const spot = standingPoints(slot, outward, 1.2, { x: 9.8, z: 1 }); // truck on the back side
    expect(spot.normal).toEqual(outward);
    expect(spot.near.x).toBeCloseTo(-6.9);
    expect(spot.before.x).toBeCloseTo(-8.2);
  });

  it('approaches a pallet on the floor from the truck side', () => {
    const spot = standingPoints({ x: 0, z: 0 }, null, 1, { x: 0, z: 5 });
    expect(spot.normal).toEqual({ x: 0, z: 1 });
    expect(spot.before.z).toBeCloseTo(2.3);
  });

  it('parks along the aisle clear of the other truck', () => {
    const at = { x: -8, z: 0 };
    expect(clearSpot(at, outward, [])).toEqual(at);
    const moved = clearSpot(at, outward, [{ x: -8, z: 0.5 }]);
    expect(moved.x).toBeCloseTo(-8);
    expect(Math.abs(moved.z - 0.5)).toBeGreaterThanOrEqual(PARK_GAP);
  });
});

describe('pallet in a rack slot', () => {
  const slot = { width: 2.7, height: 1.4, depth: 1.1 };

  it('gives two boxes in one slot opposite sides, whatever side they claim', () => {
    const sides = palletSides([{ id: 'A', slotSide: 'left' }, { id: 'B', slotSide: 'left' }]);
    expect([sides.get('A'), sides.get('B')]).toEqual([-1, 1]);
    expect(palletSides([{ id: 'C', slotSide: 'right' }]).get('C')).toBe(1);
  });

  it('keeps each pallet inside its half of the bay and inside the rack depth', () => {
    for (const box of [{ width: 0.4, height: 0.28, depth: 0.3 }, { width: 1.35, height: 1.25, depth: 1.1 }]) {
      const left = palletFit(slot, -1, box);
      const right = palletFit(slot, 1, box);
      expect(left.offset + left.width / 2).toBeLessThanOrEqual(0);
      expect(right.offset - right.width / 2).toBeGreaterThanOrEqual(0);
      expect(right.offset + right.width / 2).toBeLessThanOrEqual(slot.width / 2);
      expect(left.depth).toBeLessThanOrEqual(slot.depth);
      expect(left.width).toBeGreaterThanOrEqual(Math.min(box.width, 1.2));
    }
  });

  it('rests the pallet on the beam and the box on the pallet', () => {
    const fit = palletFit(slot, 1, { width: 1, height: 0.5, depth: 1 });
    expect(fit.bottom).toBeCloseTo(BEAM_HALF); // above the slot's lower edge
    expect(fit.boxCentre).toBeCloseTo(BEAM_HALF + PALLET_HEIGHT + 0.25);
    const top = palletFit(slot, 1, { width: 1, height: 1.25, depth: 1 });
    expect(top.boxCentre + 0.625).toBeLessThanOrEqual(slot.height + BEAM_HALF + 1e-9);
  });
});
