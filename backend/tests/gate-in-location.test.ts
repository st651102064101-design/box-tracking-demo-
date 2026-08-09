import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;

/**
 * WH-001 has a 3-slot master location layout (A/1/1, A/1/2, A/2/1) and one
 * box already sitting in A/1/1 — so "suggest an empty shelf" has exactly two
 * real candidates to choose from, and picking A/1/1 again would be the bug.
 */
beforeAll(async () => {
  ctx = await bootstrap();
  await request(ctx.app)
    .put('/api/state')
    .set(auth(ctx.token))
    .send({
      boxes: {
        'OCCUPIED-1': {
          tag: 'OCCUPIED-1',
          type: 'BT-001',
          status: 'warehouse',
          labeled: true,
          location: { wh: 'WH-001', zone: 'A', rack: '1', shelf: '1', slot: '' },
          history: [],
        },
        'RETURN-1': {
          tag: 'RETURN-1',
          type: 'BT-001',
          status: 'out',
          labeled: true,
          customer: 'CUST-001',
          location: {},
          history: [],
        },
        'RETURN-2': {
          tag: 'RETURN-2',
          type: 'BT-001',
          status: 'out',
          labeled: true,
          customer: 'CUST-001',
          location: {},
          history: [],
        },
        // Already 'warehouse' (unlike RETURN-1/2, which are 'out' and can't
        // be put away directly) — exist purely to fill the two remaining
        // free master locations for the "every location taken" case below.
        'FILLER-1': { tag: 'FILLER-1', type: 'BT-001', status: 'warehouse', labeled: true, location: {}, history: [] },
        'FILLER-2': { tag: 'FILLER-2', type: 'BT-001', status: 'warehouse', labeled: true, location: {}, history: [] },
      },
      customers: { 'CUST-001': { id: 'CUST-001', name: 'ลูกค้า' } },
      boxtypes: { 'BT-001': { id: 'BT-001', name: 'ลังพลาสติก', value: 450 } },
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [1], gateTypes: { '1': 'both' } } },
      gates: { '1': 'WH-001' },
      locations: {
        'WH-001-A-1-1': { wh: 'WH-001', zone: 'A', rack: '1', shelf: '1', slot: '' },
        'WH-001-A-1-2': { wh: 'WH-001', zone: 'A', rack: '1', shelf: '2', slot: '' },
        'WH-001-A-2-1': { wh: 'WH-001', zone: 'A', rack: '2', shelf: '1', slot: '' },
      },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

describe('GET /api/boxes/suggest-location', () => {
  it('requires a warehouse', async () => {
    const res = await request(ctx.app).get('/api/boxes/suggest-location').set(auth(ctx.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('wh_required');
  });

  it('skips the occupied shelf and suggests one that is actually free', async () => {
    const res = await request(ctx.app).get('/api/boxes/suggest-location?wh=WH-001').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.suggestion).not.toBeNull();
    expect(res.body.suggestion).not.toMatchObject({ zone: 'A', rack: '1', shelf: '1' });
    expect(['WH-001-A-1-2', 'WH-001-A-2-1']).toContain(
      `WH-001-${res.body.suggestion.zone}-${res.body.suggestion.rack}-${res.body.suggestion.shelf}`,
    );
  });

  it('returns null (not an error) for a warehouse with no master locations', async () => {
    const res = await request(ctx.app).get('/api/boxes/suggest-location?wh=WH-EMPTY').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.suggestion).toBeNull();
  });

  it('returns null once every defined location already has a box', async () => {
    // Fill the two remaining free shelves via ordinary putaway.
    const p1 = await request(ctx.app)
      .post('/api/boxes/FILLER-1/putaway')
      .set(auth(ctx.token))
      .send({ wh: 'WH-001', zone: 'A', rack: '1', shelf: '2' });
    expect(p1.status).toBe(200);
    const p2 = await request(ctx.app)
      .post('/api/boxes/FILLER-2/putaway')
      .set(auth(ctx.token))
      .send({ wh: 'WH-001', zone: 'A', rack: '2', shelf: '1' });
    expect(p2.status).toBe(200);
    const res = await request(ctx.app).get('/api/boxes/suggest-location?wh=WH-001').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.suggestion).toBeNull();
  });
});

describe('POST /api/gate/in with location', () => {
  it('leaves location untouched when omitted (pending-putaway, unchanged behavior)', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['RETURN-1'], gate: 1 });
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/RETURN-1').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    // Never had a location to begin with (seeded {}) — gateIn without
    // `location` must not have invented one.
    expect(box.body.location).toEqual({});
  });

  it('applies the chosen location to a box that lands on warehouse', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['OCCUPIED-1'], gate: 1, location: { zone: 'B', rack: '9', shelf: '9', slot: '9' } });
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/OCCUPIED-1').set(auth(ctx.token));
    expect(box.body.location).toMatchObject({ wh: 'WH-001', zone: 'B', rack: '9', shelf: '9', slot: '9' });
    const last = box.body.history.at(-1);
    expect(last.dir).toBe('in');
    expect(last.loc).toMatchObject({ zone: 'B', rack: '9', shelf: '9', slot: '9' });
  });

  it('does not apply the location to a tag flagged hold/damage in the same batch', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({
        tags: ['RETURN-2'],
        gate: 1,
        location: { zone: 'C', rack: '1', shelf: '1' },
        conditions: { 'RETURN-2': 'damage' },
      });
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/RETURN-2').set(auth(ctx.token));
    expect(box.body.status).toBe('damage');
    // Never had a location — a damaged box didn't just get shelved at the
    // location meant for its warehouse-bound batchmates.
    expect(box.body.location).toEqual({});
  });
});
