import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
  // seed a warehouse/gate, customer and one warehouse-resident box via the bridge
  await request(ctx.app)
    .put('/api/state')
    .set(auth(ctx.token))
    .send({
      boxes: {
        'BTX-1': { tag: 'BTX-1', type: 'BT-001', value: 450, status: 'warehouse', cycles: 0, labeled: true, history: [], location: {} },
      },
      customers: { 'CUST-001': { id: 'CUST-001', name: 'ลูกค้า ก', returnDays: 10 } },
      boxtypes: { 'BT-001': { id: 'BT-001', name: 'ลังพลาสติก', value: 450 } },
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [5], gateTypes: { '5': 'both' } } },
      gates: { '5': 'WH-001' },
      employees: {
        'EMP-0001': { id: 'EMP-0001', name: 'สมชาย ใจดี', role: 'พนักงานคลัง', access: 'operator', status: 'active' },
        'EMP-0009': { id: 'EMP-0009', name: 'วิชัย พ้นสภาพ', access: 'operator', status: 'inactive' },
      },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

describe('gate operations', () => {
  it('ships a box out (status → out, due date set)', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-1'], customer: 'CUST-001', gate: 5, doNo: 'DO-9001', recorder: 'tester' });
    expect(res.status).toBe(200);
    expect(res.body.shipped).toEqual(['BTX-1']);

    const box = await request(ctx.app).get('/api/boxes/BTX-1').set(auth(ctx.token));
    expect(box.body.status).toBe('out');
    expect(box.body.customer).toBe('CUST-001');
    expect(box.body.do).toBe('DO-9001');
    expect(box.body.dueAt).toBeTruthy();
  });

  it('receives the box back (status → warehouse, cycles++)', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-1'], gate: 5, recorder: 'tester' });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual(['BTX-1']);

    const box = await request(ctx.app).get('/api/boxes/BTX-1').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    expect(box.body.cycles).toBe(1);
  });

  it('generates a readable DO number when the caller omits one (not a raw epoch stamp)', async () => {
    await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag: 'BTX-NODONO', type: 'BT-001' });
    await request(ctx.app).post('/api/boxes/BTX-NODONO/label').set(auth(ctx.token));
    await request(ctx.app).post('/api/boxes/BTX-NODONO/putaway').set(auth(ctx.token)).send({ wh: 'WH-001' });
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-NODONO'], customer: 'CUST-001', gate: 5, recorder: 'tester' });
    expect(res.status).toBe(200);
    // Same shape the legacy web UI's genDocNo('DO') produces: DO-YYYY-MM-DD-HHMMSS.
    // Used to be `DO-${Date.now()}` (e.g. DO-1786556123050) — nothing like what
    // the web app generates for the same kind of record.
    expect(res.body.doNo).toMatch(/^DO-\d{4}-\d{2}-\d{2}-\d{6}$/);
  });

  it('rejects shipping an unknown box', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['NOPE'], customer: 'CUST-001', gate: 5 });
    expect(res.status).toBe(404);
  });

  it('rejects scanning in a box that is already in the warehouse', async () => {
    // BTX-1 is back to 'warehouse' from the earlier "receives the box back"
    // test in this same describe block — scanning it in again (a mis-scan,
    // or someone re-running a receipt that already went through) must not
    // silently re-stamp it as just-arrived.
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-1'], gate: 5, recorder: 'tester' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('box_already_in_warehouse');
    expect(res.body.message).toContain('BTX-1');

    // Rejected outright — not just reported, but state must be untouched.
    const box = await request(ctx.app).get('/api/boxes/BTX-1').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    expect(box.body.cycles).toBe(1);
  });

  it('rejects shipping a box that is already out with a customer, to any customer', async () => {
    await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag: 'BTX-OUT-1', type: 'BT-001' });
    await request(ctx.app).post('/api/boxes/BTX-OUT-1/label').set(auth(ctx.token));
    await request(ctx.app).post('/api/boxes/BTX-OUT-1/putaway').set(auth(ctx.token)).send({ wh: 'WH-001' });
    await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-OUT-1'], customer: 'CUST-001', gate: 5 });

    // Same customer again — still refused; the box hasn't come back through
    // Gate In, so it isn't sitting in this (or any) warehouse to ship.
    const sameCustomer = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-OUT-1'], customer: 'CUST-001', gate: 5 });
    expect(sameCustomer.status).toBe(409);
    expect(sameCustomer.body.error).toBe('box_not_shippable');
    expect(sameCustomer.body.message).toContain('BTX-OUT-1');

    // A different customer — same rejection, for the same reason. Added via
    // the additive masters endpoint, not PUT /api/state (a wholesale
    // replace that would wipe every other seeded table in this file).
    await request(ctx.app)
      .post('/api/masters/customers')
      .set(auth(ctx.token))
      .send({ id: 'CUST-002', name: 'ลูกค้า ข', returnDays: 10 });
    const otherCustomer = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-OUT-1'], customer: 'CUST-002', gate: 5 });
    expect(otherCustomer.status).toBe(409);
    expect(otherCustomer.body.error).toBe('box_not_shippable');

    const box = await request(ctx.app).get('/api/boxes/BTX-OUT-1').set(auth(ctx.token));
    expect(box.body.status).toBe('out');
    expect(box.body.customer).toBe('CUST-001');
  });
});

/**
 * Handhelds identify their operator by badge and send the employee id. The
 * name written into history is looked up here rather than taken on trust, and
 * the terminal is recorded from its own token — so "who scanned this, on which
 * device" survives even though no warehouse employee has a login.
 */
describe('operator attribution', () => {
  it('takes the recorder name from the employee master, not the request body', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({
        tags: ['BTX-1'],
        customer: 'CUST-001',
        gate: 5,
        employeeId: 'EMP-0001',
        recorder: 'ใครก็ไม่รู้',
      });
    expect(res.status).toBe(200);

    const box = await request(ctx.app).get('/api/boxes/BTX-1').set(auth(ctx.token));
    const last = box.body.history.at(-1);
    expect(last.recorder).toBe('สมชาย ใจดี');
    expect(last.employeeId).toBe('EMP-0001');
    expect(last.device).toBe('admin');
  });

  it('refuses a scan from an employee who is no longer active', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-1'], gate: 5, employeeId: 'EMP-0009' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('employee_inactive');
  });

  it('refuses a badge that matches nobody', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-1'], gate: 5, employeeId: 'EMP-NOPE' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('employee_not_found');
  });

  it('still accepts a plain recorder string for integrations with no employee id', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-1'], gate: 5, recorder: 'conveyor-reader' });
    expect(res.status).toBe(200);

    const box = await request(ctx.app).get('/api/boxes/BTX-1').set(auth(ctx.token));
    expect(box.body.history.at(-1).recorder).toBe('conveyor-reader');
  });
});

/**
 * Covers the PDA Gate In queue's per-box condition dropdown (ปกติ/เสีย/พัก
 * ใช้งาน) — a box flagged while scanning it back in lands on 'hold' or
 * 'damage' instead of 'warehouse', same as marking it damaged from the web.
 */
describe('gate/in per-tag conditions', () => {
  /** Creates a box, ships it straight out to CUST-001 so it's in an
   *  'out' state ready to be gated back in by the test itself — avoids a
   *  wholesale PUT /api/state that would clobber the shared warehouse/gate
   *  seed every other test in this file relies on. */
  async function seedOutboundBox(tag: string) {
    await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag, type: 'BT-001' });
    await request(ctx.app).post(`/api/boxes/${tag}/label`).set(auth(ctx.token));
    await request(ctx.app).post(`/api/boxes/${tag}/putaway`).set(auth(ctx.token)).send({ wh: 'WH-001' });
    await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: [tag], customer: 'CUST-001', gate: 5 });
  }

  it('a box flagged damage lands on status damage, not warehouse, and cannot ship', async () => {
    await seedOutboundBox('BTX-COND-1');
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-COND-1'], gate: 5, recorder: 'tester', conditions: { 'BTX-COND-1': 'damage' } });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual(['BTX-COND-1']);

    const box = await request(ctx.app).get('/api/boxes/BTX-COND-1').set(auth(ctx.token));
    expect(box.body.status).toBe('damage');
    expect(box.body.history.at(-1).condition).toBe('damage');

    const ship = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-COND-1'], customer: 'CUST-001', gate: 5 });
    expect(ship.status).toBe(409);
  });

  it('a box flagged hold lands on status hold', async () => {
    await seedOutboundBox('BTX-COND-2');
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-COND-2'], gate: 5, recorder: 'tester', conditions: { 'BTX-COND-2': 'hold' } });
    expect(res.status).toBe(200);

    const box = await request(ctx.app).get('/api/boxes/BTX-COND-2').set(auth(ctx.token));
    expect(box.body.status).toBe('hold');
  });

  it('a tag not present in conditions still lands on warehouse as normal', async () => {
    await seedOutboundBox('BTX-COND-3');
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-COND-3'], gate: 5, recorder: 'tester' });
    expect(res.status).toBe(200);

    const box = await request(ctx.app).get('/api/boxes/BTX-COND-3').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    expect(box.body.history.at(-1).condition).toBeUndefined();
  });
});

describe('gate movements record which client sent them', () => {
  it('stamps platform on the box history entry and the event when the caller declares it', async () => {
    await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag: 'BTX-PLAT-1', type: 'BT-001' });
    await request(ctx.app).post('/api/boxes/BTX-PLAT-1/label').set(auth(ctx.token));
    await request(ctx.app).post('/api/boxes/BTX-PLAT-1/putaway').set(auth(ctx.token)).send({ wh: 'WH-001' });
    await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-PLAT-1'], customer: 'CUST-001', gate: 5, platform: 'pda' });

    const box = await request(ctx.app).get('/api/boxes/BTX-PLAT-1').set(auth(ctx.token));
    expect(box.body.history.at(-1).platform).toBe('pda');

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    const ev = state.body.events.find((e: any) => e.tag === 'BTX-PLAT-1' && e.dir === 'out');
    expect(ev.platform).toBe('pda');
  });

  it('rejects a platform value other than web/pda', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-PLAT-1'], customer: 'CUST-001', gate: 5, platform: 'toaster' });
    expect(res.status).toBe(400);
  });

  it('leaves platform unset (not defaulted to "web") when the caller omits it entirely', async () => {
    await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag: 'BTX-PLAT-2', type: 'BT-001' });
    await request(ctx.app).post('/api/boxes/BTX-PLAT-2/label').set(auth(ctx.token));
    await request(ctx.app).post('/api/boxes/BTX-PLAT-2/putaway').set(auth(ctx.token)).send({ wh: 'WH-001' });
    await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BTX-PLAT-2'], customer: 'CUST-001', gate: 5 });

    const box = await request(ctx.app).get('/api/boxes/BTX-PLAT-2').set(auth(ctx.token));
    expect(box.body.history.at(-1).platform).toBe('');
  });
});
