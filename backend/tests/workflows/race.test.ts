/** Two devices acting on one box at the same moment. Needs RACE_DB (see vitest.config.ts). */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeWorld, GATE, type World } from './world.js';

describe.skipIf(!process.env.RACE_DB)('W10 simultaneous scans', () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });
  const ROUNDS = 10;

  it('one box is shipped once when two gates scan it together', async () => {
    let doubles = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const tag = `RACE-OUT-${i}`;
      await w.stocked(tag);
      const both = await Promise.all([
        w.out([tag], GATE.out, { customer: 'C1' }),
        w.out([tag], GATE.screen, { customer: 'C2' }),
      ]);
      if (both.filter((r) => r.status === 200).length > 1) doubles++;
    }
    expect(doubles).toBe(0);
  });

  it('one return is counted once when two gates scan it together', async () => {
    let doubles = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const tag = `RACE-IN-${i}`;
      await w.stocked(tag);
      await w.out([tag]);
      const both = await Promise.all([w.in([tag], GATE.in), w.in([tag], GATE.screen)]);
      if (both.filter((r) => r.status === 200).length > 1) doubles++;
    }
    expect(doubles).toBe(0);
  });
});
