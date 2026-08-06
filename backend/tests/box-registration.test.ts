import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
  await request(ctx.app)
    .put('/api/state')
    .set(auth(ctx.token))
    .send({
      boxes: {},
      customers: {},
      boxtypes: { 'BT-001': { id: 'BT-001', name: 'ลังพลาสติก', value: 450 } },
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [1], gateTypes: { '1': 'both' } } },
      gates: { '1': 'WH-001' },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

/**
 * Covers the PDA's new "ลงทะเบียนกล่อง" flow (create -> label -> putaway),
 * copied from legacy.html's own box-registration handler
 * ($('#btnAddBox').onclick) and putaway modal.
 */
describe('POST /api/boxes — create', () => {
  it('registers a new box as pending/unlabeled, visible on the state bridge', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes')
      .set(auth(ctx.token))
      .send({ tag: 'NEW-001', type: 'BT-001' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tag: 'NEW-001', type: 'BT-001', status: 'pending', labeled: false, value: 450 });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].dir).toBe('reg');

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.boxes['NEW-001']).toMatchObject({ status: 'pending', labeled: false });
  });

  it('uppercases the tag', async () => {
    const res = await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag: 'lower-01', type: 'BT-001' });
    expect(res.status).toBe(200);
    expect(res.body.tag).toBe('LOWER-01');
  });

  it('rejects a duplicate tag', async () => {
    const res = await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag: 'NEW-001', type: 'BT-001' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tag_taken');
  });

  it('rejects an unknown box type', async () => {
    const res = await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag: 'NEW-002', type: 'NOPE' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_box_type');
  });
});

describe('POST /api/boxes/:tag/label + /putaway', () => {
  it('putaway is refused before the box is labeled', async () => {
    await request(ctx.app).post('/api/boxes').set(auth(ctx.token)).send({ tag: 'NEW-010', type: 'BT-001' });
    const res = await request(ctx.app)
      .post('/api/boxes/NEW-010/putaway')
      .set(auth(ctx.token))
      .send({ wh: 'WH-001', zone: 'A', rack: '1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_labeled');
  });

  it('label then putaway moves the box to warehouse with a location, logged as dir:putaway', async () => {
    const label = await request(ctx.app).post('/api/boxes/NEW-010/label').set(auth(ctx.token));
    expect(label.status).toBe(200);
    expect(label.body.labeled).toBe(true);
    expect(label.body.history.at(-1).dir).toBe('label');

    const putaway = await request(ctx.app)
      .post('/api/boxes/NEW-010/putaway')
      .set(auth(ctx.token))
      .send({ wh: 'WH-001', zone: 'A', rack: '1', shelf: '2', slot: '3' });
    expect(putaway.status).toBe(200);
    expect(putaway.body.status).toBe('warehouse');
    expect(putaway.body.location).toMatchObject({ wh: 'WH-001', zone: 'A', rack: '1', shelf: '2', slot: '3' });
    expect(putaway.body.history.at(-1).dir).toBe('putaway');

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.boxes['NEW-010'].status).toBe('warehouse');
  });

  it('a second putaway on an already-warehouse box logs dir:relocate, not dir:putaway', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/NEW-010/putaway')
      .set(auth(ctx.token))
      .send({ wh: 'WH-001', zone: 'B' });
    expect(res.status).toBe(200);
    expect(res.body.history.at(-1).dir).toBe('relocate');
  });

  it('labeling an already-labeled box is rejected', async () => {
    const res = await request(ctx.app).post('/api/boxes/NEW-010/label').set(auth(ctx.token));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_labeled');
  });

  it('404s for a tag that does not exist', async () => {
    const label = await request(ctx.app).post('/api/boxes/NOPE-99/label').set(auth(ctx.token));
    expect(label.status).toBe(404);
    const putaway = await request(ctx.app).post('/api/boxes/NOPE-99/putaway').set(auth(ctx.token)).send({ wh: 'WH-001' });
    expect(putaway.status).toBe(404);
  });
});
