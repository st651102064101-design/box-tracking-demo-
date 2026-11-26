/** End-to-end workflows — see docs/testing/workflows.md for the flow of each. */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeWorld, GATE, type World } from './world.js';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

describe('W1 life of a box: register → label → putaway → ship → return', () => {
  it('walks the whole cycle and keeps status, history and events in step', async () => {
    await w.register('W1-A');
    expect((await w.row('W1-A')).status).toBe('pending');
    expect((await w.out(['W1-A'])).status).toBe(409); // not received yet
    expect((await w.putaway('W1-A')).status).toBe(409); // not labelled yet
    await w.label('W1-A');
    await w.putaway('W1-A');
    expect((await w.out(['W1-A'])).status).toBe(200);
    expect(await w.row('W1-A')).toMatchObject({ status: 'out', customer: 'C1', outGate: GATE.out });
    expect((await w.out(['W1-A'])).status).toBe(409); // already out
    expect((await w.in(['W1-A'])).status).toBe(200);
    expect(await w.row('W1-A')).toMatchObject({ status: 'warehouse', cycles: 1, customer: null, doNo: null });
    expect((await w.in(['W1-A'])).status).toBe(409); // already in
    expect(await w.dirs('W1-A')).toEqual(['reg', 'label', 'putaway', 'out', 'in']);
    expect(await w.events('W1-A')).toEqual(['out', 'in']);
  });

  it('refuses a duplicate barcode, whatever its letter case', async () => {
    await w.register('W1-DUP');
    expect((await w.register('w1-dup')).status).toBe(409);
  });

  it('a batch with one bad box ships nothing', async () => {
    await w.stocked('W1-OK');
    await w.register('W1-RAW');
    expect((await w.out(['W1-OK', 'W1-RAW'])).status).toBe(409);
    expect((await w.out(['W1-OK', 'NOPE'])).status).toBe(404);
    expect((await w.row('W1-OK')).status).toBe('warehouse');
  });
});

describe('W2 handheld (PDA) receive and ship', () => {
  it('records who scanned, on which platform, and accepts RFID codes', async () => {
    await w.stocked('W2-A');
    await w.api().post('/api/boxes/W2-A/rfid').set(w.as).send({ rfidEpc: await w.epc('W2-A') });
    const res = await w.out([await w.epc('W2-A'), 'W2-A'], GATE.screen, { employeeId: 'E-ON', platform: 'pda' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // barcode + RFID of one box ship once
    expect((await w.row('W2-A')).history).toEqual(expect.arrayContaining([
      expect.objectContaining({ dir: 'out', employeeId: 'E-ON', recorder: 'on duty', platform: 'pda' }),
    ]));
  });

  it('refuses an employee who has left, and a gate that does not exist', async () => {
    await w.stocked('W2-B');
    expect((await w.out(['W2-B'], GATE.out, { employeeId: 'E-OFF' })).status).toBe(403);
    expect((await w.out(['W2-B'], 77)).status).toBe(404);
  });

  it('reports unknown codes on receive but still takes the good ones', async () => {
    await w.stocked('W2-C');
    await w.out(['W2-C']);
    const res = await w.in(['W2-C', 'GHOST']);
    expect(res.body).toMatchObject({ received: ['W2-C'], unknown: ['GHOST'] });
  });

  it('an out-only gate does not receive, and an in-only gate does not ship', async () => {
    await w.stocked('W2-D');
    const shipAtInGate = await w.out(['W2-D'], GATE.in);
    await w.stocked('W2-E');
    await w.out(['W2-E']);
    const receiveAtOutGate = await w.in(['W2-E'], GATE.out);
    expect([shipAtInGate.status, receiveAtOutGate.status]).toEqual([409, 409]);
  });
});

describe('W3 problems: damaged, held, lost', () => {
  it('a damaged return is blocked from shipping until released and put away', async () => {
    await w.stocked('W3-A');
    await w.out(['W3-A']);
    await w.in(['W3-A'], GATE.in, { conditions: { 'W3-A': 'damage' } });
    expect(await w.row('W3-A')).toMatchObject({ status: 'damage', cycles: 1 });
    expect((await w.out(['W3-A'])).status).toBe(409);
    expect((await w.hold('W3-A', 'warehouse')).status).toBe(200);
    expect((await w.putaway('W3-A')).status).toBe(200);
    expect((await w.out(['W3-A'])).status).toBe(200);
  });

  it('the condition applies when the operator scanned the RFID tag, not the barcode', async () => {
    await w.stocked('W3-B');
    const epc = await w.epc('W3-B');
    await w.api().post('/api/boxes/W3-B/rfid').set(w.as).send({ rfidEpc: epc });
    await w.out(['W3-B']);
    await w.in([epc], GATE.in, { conditions: { [epc]: 'damage' } });
    expect((await w.row('W3-B')).status).toBe('damage');
  });

  it.each(['hold', 'damage'] as const)('scanning a %s box at the in-gate does not silently release it', async (flag) => {
    const tag = `W3-${flag.toUpperCase()}`;
    await w.stocked(tag);
    await w.hold(tag, flag);
    await w.in([tag]);
    expect((await w.row(tag)).status).toBe(flag);
  });

  it('a shipped box cannot be put on hold', async () => {
    await w.stocked('W3-C');
    await w.out(['W3-C']);
    expect((await w.hold('W3-C', 'hold')).status).toBe(409);
  });

  it('a lost box that turns up at the gate remembers which customer had it', async () => {
    await w.stocked('W3-LOST');
    await w.out(['W3-LOST']);
    const state = await w.state();
    Object.assign(state.boxes['W3-LOST'], { status: 'lost', lostAt: new Date().toISOString() });
    await w.save(state);
    expect((await w.in(['W3-LOST'])).status).toBe(200);
    const last = ((await w.row('W3-LOST')).history as Record<string, unknown>[]).at(-1)!;
    expect(last.customer).toBe('C1');
  });
});

describe('W4 move between warehouses', () => {
  it('ships from where the box is now, not where it started', async () => {
    await w.stocked('W4-A');
    expect((await w.out(['W4-A'], GATE.otherWh)).status).toBe(409);
    await w.out(['W4-A']);
    await w.in(['W4-A'], GATE.otherWh);
    expect((await w.out(['W4-A'], GATE.out)).status).toBe(409);
    expect((await w.out(['W4-A'], GATE.otherWh)).status).toBe(200);
  });
});

describe('W5 fixed RFID reader', () => {
  it('dedicated gates move stock on their own, once', async () => {
    await w.stocked('W5-A');
    await w.session(GATE.out);
    await w.read(GATE.out, ['W5-A']);
    expect((await w.row('W5-A')).status).toBe('out');
    await w.read(GATE.in, ['W5-A']);
    await w.read(GATE.in, ['W5-A']);
    expect(await w.row('W5-A')).toMatchObject({ status: 'warehouse', cycles: 1 });
    expect((await w.dirs('W5-A')).filter((d) => d === 'in')).toHaveLength(1);
  });

  it('without a chosen customer the out-gate only queues the box', async () => {
    await w.stocked('W5-B');
    await w.api().delete(`/api/rfid/gates/${GATE.out}/auto-session`).set(w.as);
    await w.read(GATE.out, ['W5-B']);
    expect((await w.row('W5-B')).status).toBe('warehouse');
    expect(await w.pending(GATE.out)).toContain('W5-B');
  });

  it('a two-way screen gate waits for the operator', async () => {
    await w.stocked('W5-C');
    await w.read(GATE.screen, ['W5-C']);
    expect((await w.row('W5-C')).status).toBe('warehouse');
    expect(await w.pending(GATE.screen)).toContain('W5-C');
    await w.out(['W5-C'], GATE.screen);
    expect(await w.pending(GATE.screen)).not.toContain('W5-C'); // queue is emptied by the shipment
  });

  it('a two-antenna gate reads the direction: inner→outer ships, outer→inner receives', async () => {
    await w.stocked('W5-D');
    await w.session(GATE.antenna);
    await w.read(GATE.antenna, ['W5-D'], 2);
    await w.read(GATE.antenna, ['W5-D'], 1);
    expect((await w.row('W5-D')).status).toBe('out');
    await w.read(GATE.antenna, ['W5-D'], 1);
    await w.read(GATE.antenna, ['W5-D'], 2);
    expect((await w.row('W5-D')).status).toBe('warehouse');
  });

  it('never ships a box that belongs to another warehouse', async () => {
    await w.stocked('W5-E', 'WH-2');
    await w.session(GATE.out);
    await w.read(GATE.out, ['W5-E']);
    expect((await w.row('W5-E')).status).toBe('warehouse');
  });

  it('a damaged box is not shipped by the reader', async () => {
    await w.stocked('W5-F');
    await w.hold('W5-F', 'damage');
    await w.session(GATE.out);
    await w.read(GATE.out, ['W5-F']);
    expect((await w.row('W5-F')).status).toBe('damage');
  });

  it('a held box passing the in-gate stays held', async () => {
    await w.stocked('W5-G');
    await w.hold('W5-G', 'hold');
    await w.read(GATE.in, ['W5-G']);
    expect((await w.row('W5-G')).status).toBe('hold');
  });
});

describe('W6 RFID + licence-plate camera', () => {
  it('ships only when the planned plate arrives, and records it', async () => {
    await w.stocked('W6-A');
    await w.session(GATE.out, { plate: '1AB1234' });
    await w.read(GATE.out, ['W6-A']);
    expect((await w.row('W6-A')).status).toBe('warehouse');
    expect((await w.camera(GATE.out, 'WRONG99')).body.reason).toBe('plate_mismatch');
    expect((await w.row('W6-A')).status).toBe('warehouse');
    expect((await w.camera(GATE.out, '1AB1234')).body.action).toBe('open_gate');
    expect((await w.row('W6-A')).status).toBe('out');
    expect(await w.dirs('W6-A')).toEqual(expect.arrayContaining(['out', 'lpr']));
  });

  it('a doubtful plate reading neither opens the gate nor ships', async () => {
    await w.stocked('W6-B');
    await w.session(GATE.out, { plate: '2CD5678' });
    await w.read(GATE.out, ['W6-B']);
    expect((await w.camera(GATE.out, '2CD5678', { confidence: 0.2 })).body.action).toBe('manual_review');
    expect((await w.row('W6-B')).status).toBe('warehouse');
  });
});

describe('W7 stock count', () => {
  const open = () => w.api().post('/api/cycle-counts').set(w.as).send({ wh: 'WH-1' });
  const scan = (id: string, tags: string[]) => w.api().post(`/api/cycle-counts/${id}/scan`).set(w.as).send({ tags });
  const close = (id: string) => w.api().post(`/api/cycle-counts/${id}/close`).set(w.as).send({});
  const lose = (id: string) => w.api().post(`/api/cycle-counts/${id}/mark-missing-lost`).set(w.as).send({});

  it('finds what is missing, and closing alone changes no box', async () => {
    await w.stocked('W7-SEEN');
    await w.stocked('W7-GONE');
    const id = (await open()).body.id;
    await scan(id, ['W7-SEEN']);
    const result = (await close(id)).body;
    expect(result.missing).toContain('W7-GONE');
    expect((await w.row('W7-GONE')).status).toBe('warehouse');
    expect((await scan(id, ['W7-GONE'])).status).toBe(409);
  });

  it('"mark missing as lost" needs a closed count', async () => {
    await w.stocked('W7-OPEN');
    const id = (await open()).body.id;
    const res = await lose(id);
    const status = (await w.row('W7-OPEN')).status;
    await close(id);
    expect([res.status, status]).toEqual([409, 'warehouse']);
  });

  it('does not mark a box lost that was shipped after the count', async () => {
    await w.stocked('W7-SHIPPED');
    const id = (await open()).body.id;
    await close(id);
    await w.out(['W7-SHIPPED']);
    await lose(id);
    expect((await w.row('W7-SHIPPED')).status).toBe('out');
  });
});

describe('W8 web and handheld working at the same time', () => {
  it('a web save made from an older screen does not undo a handheld shipment', async () => {
    await w.stocked('W8-A');
    const oldScreen = await w.state(); // web page loaded
    await w.out(['W8-A'], GATE.out, { platform: 'pda' }); // handheld ships
    oldScreen.customers.C2.name = 'renamed'; // web user edits something unrelated
    await w.save(oldScreen);
    expect((await w.row('W8-A')).status).toBe('out');
    expect(await w.events('W8-A')).toEqual(['out']);
  });

  it('a web save made from an older screen does not delete a box registered since', async () => {
    const oldScreen = await w.state();
    await w.register('W8-NEW');
    await w.save(oldScreen);
    expect(await w.row('W8-NEW')).toBeDefined();
  });

  it('a web save made from an older screen does not release a hold', async () => {
    await w.stocked('W8-H');
    const oldScreen = await w.state();
    await w.hold('W8-H', 'hold');
    await w.save(oldScreen);
    expect((await w.row('W8-H')).status).toBe('hold');
  });
});

describe('W9 master data in use', () => {
  /* Deleting master data is a soft delete on purpose (history keeps resolving).
     What matters is that a deleted entry cannot be used for new work. */
  it('a deleted customer cannot receive new shipments', async () => {
    await w.stocked('W9-A');
    await w.api().delete('/api/masters/customers/C3').set(w.as);
    expect((await w.out(['W9-A'], GATE.out, { customer: 'C3' })).status).toBe(404);
  });

  it('a deleted box type cannot be used for new boxes', async () => {
    await w.api().delete('/api/masters/box-types/BT-OLD').set(w.as);
    const res = await w.api().post('/api/boxes').set(w.as).send({ tag: 'W9-T', type: 'BT-OLD' });
    expect(res.status).toBe(400);
  });

  it('reusing a delivery-order number does not rewrite the earlier delivery', async () => {
    await w.stocked('W9-B');
    await w.stocked('W9-C');
    await w.out(['W9-B'], GATE.out, { customer: 'C1', doNo: 'DO-SAME' });
    const second = await w.out(['W9-C'], GATE.out, { customer: 'C2', doNo: 'DO-SAME' });
    const record = (await w.state()).doRecords['DO-SAME'];
    expect([second.status, record.customer]).toEqual([409, 'C1']);
  });
});

describe('W11 the same rules on a web (whole-state) save', () => {
  const rejected = (res: { body: { rejected: { key: string }[] } }) => res.body.rejected.map((r) => r.key);
  /** What the web page does: change the box in memory, log it, upload everything. */
  function move(state: any, tag: string, dir: 'in' | 'out', gate: number, extra: object = {}) {
    const ts = new Date().toISOString();
    const box = state.boxes[tag];
    Object.assign(box, dir === 'out'
      ? { status: 'out', customer: 'C1', outGate: gate, ...extra }
      : { status: 'warehouse', customer: '', do: '' });
    box.history = [...box.history, { dir, ts, gate, wh: 'WH-1' }];
    state.events = [...state.events, { dir, ts, tag, gate }];
  }

  it('an ordinary web shipment and return are saved', async () => {
    await w.stocked('W11-A');
    const state = await w.state();
    move(state, 'W11-A', 'out', GATE.out);
    expect(rejected(await w.save(state))).toEqual([]);
    move(state, 'W11-A', 'in', GATE.in);
    expect(rejected(await w.save(state))).toEqual([]); // same page saving again is not "stale"
    expect((await w.row('W11-A')).status).toBe('warehouse');
  });

  it('tells the user which boxes were not overwritten', async () => {
    await w.stocked('W11-S');
    const oldScreen = await w.state();
    await w.out(['W11-S']);
    const res = await w.save(oldScreen);
    expect(rejected(res)).toEqual(['staleBoxes']);
    expect(res.body.rejected[0].message).toContain('W11-S');
  });

  it('a page can still delete a box it knows about', async () => {
    await w.stocked('W11-DEL');
    const state = await w.state();
    delete state.boxes['W11-DEL'];
    await w.save(state);
    expect(await w.row('W11-DEL')).toBeUndefined();
  });

  it('refuses the wrong gate direction', async () => {
    await w.stocked('W11-G');
    const state = await w.state();
    move(state, 'W11-G', 'out', GATE.in);
    expect(rejected(await w.save(state))).toEqual(['gateDirection']);
    expect((await w.row('W11-G')).status).toBe('warehouse');
    expect(await w.events('W11-G')).toEqual([]);
  });

  it('does not release a held box by receiving it', async () => {
    await w.stocked('W11-H');
    await w.hold('W11-H', 'hold');
    const state = await w.state();
    move(state, 'W11-H', 'in', GATE.in);
    expect(rejected(await w.save(state))).toEqual(['flaggedBox']);
    expect((await w.row('W11-H')).status).toBe('hold');
  });

  it('refuses a delivery-order number that belongs to another customer', async () => {
    await w.stocked('W11-D1');
    await w.stocked('W11-D2');
    await w.out(['W11-D1'], GATE.out, { doNo: 'DO-W11', customer: 'C1' });
    const state = await w.state();
    move(state, 'W11-D2', 'out', GATE.out, { customer: 'C2', do: 'DO-W11' });
    state.doRecords['DO-W11'] = { customer: 'C2' };
    expect(rejected(await w.save(state))).toEqual(['doNumber']);
    expect((await w.state()).doRecords['DO-W11'].customer).toBe('C1');
  });

  it('an admin restoring a backup does replace newer data', async () => {
    await w.stocked('W11-R');
    const backup = await w.state();
    await w.out(['W11-R']);
    delete backup.baseTags;
    expect(rejected(await w.save({ ...backup, restore: true }))).toEqual([]);
    expect((await w.row('W11-R')).status).toBe('warehouse');
  });
});
