import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

/**
 * Full box lifecycle, exercised end to end through the real REST surface
 * (masters CRUD → box creation via the state bridge → gate out → gate in →
 * every status the web UI can put a box in) rather than mocking any layer —
 * this is what actually catches typed-column vs. jsonb-data drift that a
 * unit test of a single function misses.
 *
 * PUT /api/state is a WHOLESALE REPLACE, not a merge (see services/state.ts
 * replaceState — it wipes every domain table, then re-inserts only what's in
 * the payload). So every PUT below sends the *entire* running `state`
 * object, exactly like the legacy web UI's own `S` + `save()` does — a PUT
 * with just `{boxes: {...}}` after an earlier PUT that set up warehouses/
 * employees would silently delete all of those.
 */
let ctx: TestCtx;
let state: Record<string, unknown>;

async function putState(patch: Record<string, unknown>) {
  Object.assign(state, patch);
  return request(ctx.app).put('/api/state').set(auth(ctx.token)).send(state);
}

/** REST calls (RFID associate, gate/out, gate/in) mutate the DB directly —
 *  they never touch the local `state` mirror above. Call this after any of
 *  them and before the next putState() call, or that PUT's wholesale-replace
 *  semantics silently wipe out whatever the REST call just did. */
async function syncBoxFromServer(tag: string) {
  const res = await request(ctx.app).get(`/api/boxes/${tag}`).set(auth(ctx.token));
  (state.boxes as Record<string, unknown>)[tag] = res.body;
}

beforeAll(async () => {
  ctx = await bootstrap();
  state = {
    warehouses: { 'WH-LC': { id: 'WH-LC', name: 'คลัง LC', gates: [9], gateTypes: { '9': 'both' } } },
    gates: { '9': 'WH-LC' },
    employees: {
      'EMP-LC': { id: 'EMP-LC', name: 'ทดสอบ วงจร', role: 'พนักงานคลัง', access: 'operator', status: 'active' },
    },
    boxtypes: { 'BT-LC': { id: 'BT-LC', name: 'ลังพลาสติก LC', unit: 'ใบ', value: 500, dim: '40x30x30' } },
    customers: { 'CUST-LC': { id: 'CUST-LC', name: 'ลูกค้าทดสอบ LC', returnDays: 7 } },
    boxes: {},
  };
});

describe('masters CRUD (REST, independent of the state-bridge wipe above)', () => {
  it('creates a box type', async () => {
    const res = await request(ctx.app)
      .post('/api/masters/box-types')
      .set(auth(ctx.token))
      .send({ id: 'BT-REST', name: 'กล่อง REST', unit: 'ใบ', value: 300 });
    expect(res.status).toBe(201);
  });

  it('rejects a duplicate box type id', async () => {
    const res = await request(ctx.app)
      .post('/api/masters/box-types')
      .set(auth(ctx.token))
      .send({ id: 'BT-REST', name: 'ซ้ำ', unit: 'ใบ', value: 300 });
    expect(res.status).toBe(409);
  });

  it('updates a box type', async () => {
    const res = await request(ctx.app)
      .put('/api/masters/box-types/BT-REST')
      .set(auth(ctx.token))
      .send({ name: 'กล่อง REST แก้ไข', unit: 'ใบ', value: 350 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('กล่อง REST แก้ไข');
  });

  it('deletes a box type', async () => {
    const res = await request(ctx.app).delete('/api/masters/box-types/BT-REST').set(auth(ctx.token));
    expect(res.status).toBe(200);
  });

  it('404s deleting an unknown box type', async () => {
    const res = await request(ctx.app).delete('/api/masters/box-types/NOPE').set(auth(ctx.token));
    expect(res.status).toBe(404);
  });

  it('creates, updates, and deletes a customer', async () => {
    const create = await request(ctx.app)
      .post('/api/masters/customers')
      .set(auth(ctx.token))
      .send({ id: 'CUST-REST', name: 'ลูกค้า REST', returnDays: 14 });
    expect(create.status).toBe(201);

    const update = await request(ctx.app)
      .put('/api/masters/customers/CUST-REST')
      .set(auth(ctx.token))
      .send({ name: 'ลูกค้า REST แก้ไข', returnDays: 20 });
    expect(update.status).toBe(200);
    expect(update.body.returnDays).toBe(20);

    const del = await request(ctx.app).delete('/api/masters/customers/CUST-REST').set(auth(ctx.token));
    expect(del.status).toBe(200);
  });
});

describe('full box lifecycle', () => {
  it('seeds warehouse/gate/employee/box type/customer', async () => {
    const res = await putState({});
    expect(res.status).toBe(200);
  });

  it('registers a new box: pending, unlabeled', async () => {
    const res = await putState({
      boxes: {
        'BOX-LC-1': { tag: 'BOX-LC-1', type: 'BT-LC', value: 500, status: 'pending', labeled: false, cycles: 0, history: [], location: {} },
      },
    });
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('pending');
    expect(box.body.labeled).toBe(false);
  });

  it('labels the box (pending, awaiting putaway)', async () => {
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-1'].labeled = true;
    const res = await putState({});
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('pending');
    expect(box.body.labeled).toBe(true);
  });

  it('associates an RFID tag to the box', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-LC-1/rfid')
      .set(auth(ctx.token))
      .send({ rfidTid: 'E200001122334455', rfidEpc: '3034AABBCCDD' });
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.rfidTid).toBe('E200001122334455');
    expect(box.body.rfidEpc).toBe('3034AABBCCDD');
  });

  it('refuses re-associating the same TID to another box without replace:true', async () => {
    await syncBoxFromServer('BOX-LC-1'); // pick up the rfidTid the REST call above just set
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-2'] = { tag: 'BOX-LC-2', type: 'BT-LC', value: 500, status: 'pending', labeled: true, cycles: 0, history: [], location: {} };
    await putState({});
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-LC-2/rfid')
      .set(auth(ctx.token))
      .send({ rfidTid: 'E200001122334455', rfidEpc: 'AABBCCDDEEFF' });
    expect(res.status).toBe(409);
  });

  it('rejects shipping a box still pending (never received into the warehouse)', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], customer: 'CUST-LC', gate: 9, employeeId: 'EMP-LC' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('box_not_shippable');
  });

  it('first-time inbound scan: pending+labeled -> warehouse (this is what actually makes it shippable)', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], gate: 9, employeeId: 'EMP-LC' });
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    expect(box.body.cycles).toBe(0); // first-time inbound is not a "return", so cycles stays 0
  });

  it('ships the box out to the customer', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], customer: 'CUST-LC', gate: 9, employeeId: 'EMP-LC', doNo: 'DO-LC-1' });
    expect(res.status).toBe(200);
    expect(res.body.shipped).toEqual(['BOX-LC-1']);

    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('out');
    expect(box.body.customer).toBe('CUST-LC');
    expect(box.body.do).toBe('DO-LC-1');
    expect(box.body.dueAt).toBeTruthy();
  });

  it('receiving the box back clears customer/DO/dueAt — it must not look still-shipped', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], gate: 9, employeeId: 'EMP-LC' });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual(['BOX-LC-1']);

    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    expect(box.body.cycles).toBe(1);
    // Every inbound path in the legacy web UI clears these on return (see
    // legacy.html ~5552/5559/7296/4899) — the REST gate.ts service must
    // match, or a box returned via a physical reader / PDA keeps reporting a
    // customer/DO/due-date it no longer actually has.
    expect(box.body.customer).toBeFalsy();
    expect(box.body.do).toBeFalsy();
    expect(box.body.dueAt).toBeFalsy();
  });

  it('ships again and returns again — cycles increments each real round trip', async () => {
    await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], customer: 'CUST-LC', gate: 9, employeeId: 'EMP-LC', doNo: 'DO-LC-2' });
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], gate: 9, employeeId: 'EMP-LC' });
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.cycles).toBe(2);
    expect(box.body.customer).toBeFalsy();
  });

  it('puts the box on Hold via the state bridge (no dedicated REST endpoint — matches the web UI)', async () => {
    await syncBoxFromServer('BOX-LC-1'); // pick up cycles/customer/dueAt from the REST gate calls above
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-1'].status = 'hold';
    const res = await putState({});
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('hold');
  });

  it('takes the box off Hold, back to warehouse', async () => {
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-1'].status = 'warehouse';
    const res = await putState({});
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
  });

  it('marks the box Damaged', async () => {
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-1'].status = 'damage';
    const res = await putState({});
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('damage');
  });

  it('marks the box Lost, then recovers it back to warehouse', async () => {
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-1'].status = 'lost';
    boxes['BOX-LC-1'].lostAt = new Date().toISOString();
    boxes['BOX-LC-1'].lostReason = 'manual';
    let res = await putState({});
    expect(res.status).toBe(200);
    let box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('lost');

    boxes['BOX-LC-1'].status = 'warehouse';
    boxes['BOX-LC-1'].lostAt = null;
    boxes['BOX-LC-1'].lostReason = null;
    res = await putState({});
    expect(res.status).toBe(200);
    box = await request(ctx.app).get('/api/boxes/BOX-LC-1').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    expect(box.body.lostAt).toBeFalsy();
  });

  it('refuses shipping a box that is on Hold', async () => {
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-1'].status = 'hold';
    await putState({});
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], customer: 'CUST-LC', gate: 9, employeeId: 'EMP-LC' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('box_not_shippable');
  });

  it('refuses shipping a box that is Damaged', async () => {
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-1'].status = 'damage';
    await putState({});
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], customer: 'CUST-LC', gate: 9, employeeId: 'EMP-LC' });
    expect(res.status).toBe(409);
  });

  it('refuses shipping a box that is already out', async () => {
    const boxes = state.boxes as Record<string, any>;
    boxes['BOX-LC-1'].status = 'warehouse';
    await putState({});
    await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], customer: 'CUST-LC', gate: 9, employeeId: 'EMP-LC' });
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-LC-1'], customer: 'CUST-LC', gate: 9, employeeId: 'EMP-LC' });
    expect(res.status).toBe(409);
  });
});
