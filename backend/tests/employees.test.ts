import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

/**
 * PUT /api/employees/:id/last-post — the shared "which wh/gate did this
 * person last work" memory the PDA's badge screen and, eventually, the web
 * app both read off S.employees[id].lastWh/lastGate (see state.ts's
 * composeState, which spreads `data` verbatim into every employee).
 */
describe('PUT /api/employees/:id/last-post', () => {
  it('merges lastWh/lastGate into the employee without touching other fields', async () => {
    const seed = await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({
      boxes: {}, customers: {}, boxtypes: {}, warehouses: {}, gates: {},
      employees: { 'EMP-100': { id: 'EMP-100', name: 'ทดสอบ', role: 'operator' } },
      events: [], doRecords: {}, vehicles: {}, putaway: {}, inventory: {}, locations: {},
      cfg: {}, seq: {}, auditLog: [],
    });
    expect(seed.status).toBe(200);

    const r = await request(ctx.app)
      .put('/api/employees/EMP-100/last-post')
      .set(auth(ctx.token))
      .send({ wh: 'WH-9', gate: 3 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lastWh: 'WH-9', lastGate: '3' });

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.employees['EMP-100']).toMatchObject({
      name: 'ทดสอบ',
      role: 'operator',
      lastWh: 'WH-9',
      lastGate: '3',
    });
  });

  it('404s for an employee that does not exist', async () => {
    const r = await request(ctx.app)
      .put('/api/employees/NOPE/last-post')
      .set(auth(ctx.token))
      .send({ wh: 'WH-9', gate: 3 });
    expect(r.status).toBe(404);
  });

  it('rejects a missing warehouse', async () => {
    const r = await request(ctx.app)
      .put('/api/employees/EMP-100/last-post')
      .set(auth(ctx.token))
      .send({ gate: 3 });
    expect(r.status).toBe(400);
  });

  it('requires auth', async () => {
    const r = await request(ctx.app).put('/api/employees/EMP-100/last-post').send({ wh: 'WH-9', gate: 3 });
    expect(r.status).toBe(401);
  });
});
