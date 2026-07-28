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

  it('rejects shipping an unknown box', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['NOPE'], customer: 'CUST-001', gate: 5 });
    expect(res.status).toBe(404);
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
