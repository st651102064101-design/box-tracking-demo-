import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;

/** Three boxes on the shelf in WH-001 zone A, one in zone B, one still out. */
beforeAll(async () => {
  ctx = await bootstrap();
  const shelf = (tag: string, zone: string) => ({
    tag,
    type: 'BT-001',
    status: 'warehouse',
    labeled: true,
    location: { wh: 'WH-001', zone, rack: '1', shelf: '', slot: '' },
    history: [],
  });
  await request(ctx.app)
    .put('/api/state')
    .set(auth(ctx.token))
    .send({
      boxes: {
        'A-001': shelf('A-001', 'A'),
        'A-002': shelf('A-002', 'A'),
        'A-003': shelf('A-003', 'A'),
        'B-001': shelf('B-001', 'B'),
        'OUT-001': {
          tag: 'OUT-001',
          type: 'BT-001',
          status: 'out',
          labeled: true,
          customer: 'C-001',
          location: {},
          history: [],
        },
      },
      customers: { 'C-001': { id: 'C-001', name: 'ลูกค้า' } },
      boxtypes: { 'BT-001': { id: 'BT-001', name: 'ลังพลาสติก', value: 450 } },
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [1], gateTypes: { '1': 'both' } } },
      gates: { '1': 'WH-001' },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

const open = (wh: string, zone?: string) =>
  request(ctx.app).post('/api/cycle-counts').set(auth(ctx.token)).send({ wh, zone });

describe('POST /api/cycle-counts — open', () => {
  it('freezes the expected list for one zone, excluding boxes that are out', async () => {
    const res = await open('WH-001', 'A');
    expect(res.status).toBe(201);
    expect(res.body.resumed).toBe(false);
    expect(res.body.expected.sort()).toEqual(['A-001', 'A-002', 'A-003']);
    expect(res.body.summary).toMatchObject({ expected: 3, counted: 0, missing: 3, unexpected: 0 });
  });

  it('resumes the existing session instead of opening a second for the same post', async () => {
    const res = await open('WH-001', 'A');
    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(true);
  });

  it('counts the whole warehouse when no zone is given', async () => {
    const res = await open('WH-001');
    expect(res.status).toBe(201);
    expect(res.body.expected.sort()).toEqual(['A-001', 'A-002', 'A-003', 'B-001']);
  });
});

describe('POST /api/cycle-counts/:id/scan', () => {
  it('sorts scans into counted / unexpected / unknown and is idempotent', async () => {
    const session = (await open('WH-002', 'Z')).body; // empty zone, nothing expected
    expect(session.expected).toEqual([]);

    const first = await request(ctx.app)
      .post(`/api/cycle-counts/${session.id}/scan`)
      .set(auth(ctx.token))
      .send({ tags: ['A-001', 'NOPE-999'] });
    expect(first.status).toBe(200);
    // A-001 is a real box but isn't expected in WH-002/Z.
    expect(first.body.unexpected).toEqual(['A-001']);
    expect(first.body.unknown).toEqual(['NOPE-999']);

    // Re-scanning the same tag must not double-record it — a held RFID
    // trigger sweeps the same shelf over and over.
    const again = await request(ctx.app)
      .post(`/api/cycle-counts/${session.id}/scan`)
      .set(auth(ctx.token))
      .send({ tags: ['A-001'] });
    expect(again.body.unexpected).toEqual(['A-001']);
  });

  it('records expected boxes as counted and leaves the rest missing', async () => {
    const session = (await open('WH-001', 'A')).body;
    const res = await request(ctx.app)
      .post(`/api/cycle-counts/${session.id}/scan`)
      .set(auth(ctx.token))
      .send({ tags: ['A-001', 'A-002'] });
    expect(res.status).toBe(200);
    expect(res.body.counted.sort()).toEqual(['A-001', 'A-002']);
    expect(res.body.missing).toEqual(['A-003']);
    expect(res.body.summary).toMatchObject({ expected: 3, counted: 2, missing: 1 });
  });

  it('404s an unknown session', async () => {
    const res = await request(ctx.app)
      .post('/api/cycle-counts/CC-NOPE/scan')
      .set(auth(ctx.token))
      .send({ tags: ['A-001'] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('cycle_count_not_found');
  });
});

describe('POST /api/cycle-counts/:id/close', () => {
  it('closes, records an event, and refuses a second close', async () => {
    const session = (await open('WH-003', 'A')).body;
    const closed = await request(ctx.app)
      .post(`/api/cycle-counts/${session.id}/close`)
      .set(auth(ctx.token))
      .send({});
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.closedAt).toBeTruthy();

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    const evt = (state.body.events as Array<Record<string, unknown>>).find(
      (e) => e.dir === 'cycle-count' && e.id === session.id,
    );
    expect(evt).toBeTruthy();

    const twice = await request(ctx.app)
      .post(`/api/cycle-counts/${session.id}/close`)
      .set(auth(ctx.token))
      .send({});
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('cycle_count_closed');
  });

  it('rejects scans against a closed session', async () => {
    const session = (await open('WH-004', 'A')).body;
    await request(ctx.app).post(`/api/cycle-counts/${session.id}/close`).set(auth(ctx.token)).send({});
    const res = await request(ctx.app)
      .post(`/api/cycle-counts/${session.id}/scan`)
      .set(auth(ctx.token))
      .send({ tags: ['A-001'] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cycle_count_closed');
  });

  it('does not change box statuses on close — that stays a deliberate step', async () => {
    const session = (await open('WH-001', 'B')).body;
    await request(ctx.app).post(`/api/cycle-counts/${session.id}/close`).set(auth(ctx.token)).send({});
    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    // B-001 was never scanned, so it's "missing" — but still 'warehouse'.
    expect(state.body.boxes['B-001'].status).toBe('warehouse');
  });
});

describe('POST /api/cycle-counts/:id/mark-missing-lost', () => {
  it('marks every still-missing box lost, with history and an audit trail', async () => {
    const session = (await open('WH-005', 'A')).body;
    expect(session.expected).toEqual([]); // nothing on that shelf
    const empty = await request(ctx.app)
      .post(`/api/cycle-counts/${session.id}/mark-missing-lost`)
      .set(auth(ctx.token))
      .send({});
    expect(empty.body).toMatchObject({ updated: 0, tags: [] });
  });

  it('flips the missing boxes of a real count to lost', async () => {
    // Fresh zone with two boxes, count only one of them.
    await request(ctx.app)
      .post('/api/boxes')
      .set(auth(ctx.token))
      .send({ tag: 'CC-01', type: 'BT-001' });
    await request(ctx.app).post('/api/boxes/CC-01/label').set(auth(ctx.token)).send({});
    await request(ctx.app)
      .post('/api/boxes/CC-01/putaway')
      .set(auth(ctx.token))
      .send({ wh: 'WH-009', zone: 'Q' });

    const session = (await open('WH-009', 'Q')).body;
    expect(session.expected).toEqual(['CC-01']);

    const res = await request(ctx.app)
      .post(`/api/cycle-counts/${session.id}/mark-missing-lost`)
      .set(auth(ctx.token))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 1, tags: ['CC-01'] });

    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    expect(state.body.boxes['CC-01'].status).toBe('lost');
    const hist = state.body.boxes['CC-01'].history as Array<Record<string, unknown>>;
    expect(hist[hist.length - 1].dir).toBe('lost');
  });
});
