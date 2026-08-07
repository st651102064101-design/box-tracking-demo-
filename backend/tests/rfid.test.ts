import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
  // NOTE: PUT /api/state is a full wholesale replace (it wipes every domain
  // table and reinserts only what's in the payload) — real usage is the
  // legacy UI round-tripping its *entire* in-memory state, never a partial
  // patch. Seed everything once here; RFID-affecting state changes below go
  // through POST /api/gate/* instead, which mutate a single box in place.
  await request(ctx.app)
    .put('/api/state')
    .set(auth(ctx.token))
    .send({
      boxes: {
        'BOX-A': { tag: 'BOX-A', type: 'BT-001', value: 450, status: 'warehouse', cycles: 0, labeled: false, history: [], location: {} },
        'BOX-B': { tag: 'BOX-B', type: 'BT-001', value: 450, status: 'warehouse', cycles: 0, labeled: false, history: [], location: {} },
      },
      customers: { 'CUST-X': { id: 'CUST-X', name: 'ลูกค้า X', returnDays: 10 } },
      warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [5], gateTypes: { '5': 'both' } } },
      gates: { '5': 'WH-001' },
      cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
    });
});

describe('GET /api/rfid/encode/:tag', () => {
  it('encodes a barcode to a zero-padded 96-bit hex EPC', async () => {
    const res = await request(ctx.app).get('/api/rfid/encode/BOX-A').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.bits).toBe(96);
    expect(res.body.epcHex).toHaveLength(24);
    expect(res.body.epcHex.endsWith(Buffer.from('BOX-A', 'ascii').toString('hex').toUpperCase())).toBe(true);
  });

  it('rejects a barcode too long for the tag width', async () => {
    const res = await request(ctx.app)
      .get('/api/rfid/encode/THIS-BARCODE-IS-DEFINITELY-TOO-LONG-FOR-96-BITS')
      .set(auth(ctx.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('epc_encode_error');
  });
});

describe('POST /api/boxes/:tag/rfid — association', () => {
  it('attaches a tag to an untagged box, visible via the state-bridge JSON too', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-A/rfid')
      .set(auth(ctx.token))
      .send({ rfid: '000000000000424F582D41' });
    expect(res.status).toBe(200);
    expect(res.body.rfid).toBe('000000000000424F582D41');

    const box = await request(ctx.app).get('/api/boxes/BOX-A').set(auth(ctx.token));
    expect(box.body.rfid).toBe('000000000000424F582D41');
  });

  it('rejects a code that is already claimed by another box', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-B/rfid')
      .set(auth(ctx.token))
      .send({ rfid: '000000000000424F582D41' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('rfid_tid_in_use');
  });

  it('refuses to silently overwrite an already-tagged box without replace:true', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-A/rfid')
      .set(auth(ctx.token))
      .send({ rfid: 'AABBCCDDEEFF001122334455' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_tagged');
  });

  it('replaces a damaged tag when replace:true is sent', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-A/rfid')
      .set(auth(ctx.token))
      .send({ rfid: 'AABBCCDDEEFF001122334455', replace: true });
    expect(res.status).toBe(200);
    expect(res.body.rfid).toBe('AABBCCDDEEFF001122334455');
  });

  it('the old code is free again after a replace and can go on another box', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-B/rfid')
      .set(auth(ctx.token))
      .send({ rfid: '000000000000424F582D41' });
    expect(res.status).toBe(200);
  });

  /* A PDA or web client written against the older two-field payload must keep
   * working; the EPC is the one that survives, since that is what a reader
   * reports during the inventory sweeps these codes get scanned by. */
  it('accepts the legacy {rfidTid, rfidEpc} payload and keeps the EPC', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-B/rfid')
      .set(auth(ctx.token))
      .send({ rfidTid: 'E200001122334455', rfidEpc: '000000000000424F582D42', replace: true });
    expect(res.status).toBe(200);
    expect(res.body.rfid).toBe('000000000000424F582D42');

    const found = await request(ctx.app).get('/api/boxes/000000000000424F582D42').set(auth(ctx.token));
    expect(found.status).toBe(200);
    expect(found.body.tag).toBe('BOX-B');
  });

  it('rejects a payload carrying no RFID value at all', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-A/rfid')
      .set(auth(ctx.token))
      .send({ replace: true });
    expect(res.status).toBe(400);
  });

  it('404s for a box that does not exist', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/NOPE/rfid')
      .set(auth(ctx.token))
      .send({ rfid: '000000000000000000000001' });
    expect(res.status).toBe(404);
  });
});

describe('flexible scan resolution', () => {
  it('GET /api/boxes/:code finds a box by its RFID code', async () => {
    const res = await request(ctx.app).get('/api/boxes/AABBCCDDEEFF001122334455').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.tag).toBe('BOX-A');
  });

  it('gate/out then gate/in both accept an RFID EPC in place of the barcode', async () => {
    const out = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-A'], customer: 'CUST-X', gate: 5, recorder: 'tester' });
    expect(out.status).toBe(200);
    expect(out.body.shipped).toEqual(['BOX-A']);

    const in_ = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['AABBCCDDEEFF001122334455'], gate: 5, recorder: 'tester' });
    expect(in_.status).toBe(200);
    expect(in_.body.received).toEqual(['BOX-A']);

    const box = await request(ctx.app).get('/api/boxes/BOX-A').set(auth(ctx.token));
    expect(box.body.status).toBe('warehouse');
    expect(box.body.cycles).toBe(1);
  });

  it('gate/in reports an unresolvable scan by the raw code the operator shot', async () => {
    const res = await request(ctx.app)
      .post('/api/gate/in')
      .set(auth(ctx.token))
      .send({ tags: ['DEADBEEFDEADBEEFDEADBEEF'], gate: 5 });
    expect(res.status).toBe(200);
    expect(res.body.unknown).toEqual(['DEADBEEFDEADBEEFDEADBEEF']);
  });

  it('scanning both the barcode and the RFID of the same box in one batch counts it once', async () => {
    const out = await request(ctx.app)
      .post('/api/gate/out')
      .set(auth(ctx.token))
      .send({ tags: ['BOX-A', 'AABBCCDDEEFF001122334455'], customer: 'CUST-X', gate: 5 });
    expect(out.status).toBe(200);
    expect(out.body.shipped).toEqual(['BOX-A']);
  });
});

describe('DELETE /api/boxes/:tag/rfid', () => {
  it('detaches the tag', async () => {
    const res = await request(ctx.app).delete('/api/boxes/BOX-B/rfid').set(auth(ctx.token));
    expect(res.status).toBe(200);

    const lookup = await request(ctx.app).get('/api/boxes/000000000000424F582D42').set(auth(ctx.token));
    expect(lookup.status).toBe(404);
  });

  it('409s when the box has no tag to detach', async () => {
    const res = await request(ctx.app).delete('/api/boxes/BOX-B/rfid').set(auth(ctx.token));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_tagged');
  });
});

// The MC3390R reports no TID during inventory, and the access-read that could
// fetch one has to halt the inventory — so the PDA commissions tags by EPC
// alone. The EPC then *is* the tag's identity and carries every guard the TID
// used to.
describe('POST /api/boxes/:tag/rfid — EPC-only commissioning', () => {
  beforeAll(async () => {
    await request(ctx.app)
      .put('/api/state')
      .set(auth(ctx.token))
      .send({
        boxes: {
          'BOX-E1': { tag: 'BOX-E1', type: 'BT-001', value: 450, status: 'warehouse', cycles: 0, labeled: false, history: [], location: {} },
          'BOX-E2': { tag: 'BOX-E2', type: 'BT-001', value: 450, status: 'warehouse', cycles: 0, labeled: false, history: [], location: {} },
        },
        customers: { 'CUST-X': { id: 'CUST-X', name: 'ลูกค้า X', returnDays: 10 } },
        warehouses: { 'WH-001': { id: 'WH-001', name: 'คลัง', gates: [5], gateTypes: { '5': 'both' } } },
        gates: { '5': 'WH-001' },
        cfg: { agingDays: 15, boxValue: 450, lostMode: 'manual' },
      });
  });

  it('attaches a tag with no TID at all', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-E1/rfid')
      .set(auth(ctx.token))
      .send({ rfidEpc: 'E280691500007006A375143E' });
    expect(res.status).toBe(200);
    expect(res.body.rfidTid).toBeNull();
    expect(res.body.rfidEpc).toBe('E280691500007006A375143E');
  });

  it('resolves a later scan of that EPC back to the box', async () => {
    const box = await request(ctx.app)
      .get('/api/boxes/E280691500007006A375143E')
      .set(auth(ctx.token));
    expect(box.status).toBe(200);
    expect(box.body.tag).toBe('BOX-E1');
  });

  it('rejects the same EPC on a second box — without a TID it is the only identity the tag has', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-E2/rfid')
      .set(auth(ctx.token))
      .send({ rfidEpc: 'E280691500007006A375143E' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('rfid_tid_in_use');
  });

  it('still refuses to overwrite an EPC-commissioned box without replace:true', async () => {
    const res = await request(ctx.app)
      .post('/api/boxes/BOX-E1/rfid')
      .set(auth(ctx.token))
      .send({ rfidEpc: 'AAAA111122223333BBBB4444' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_tagged');
  });

  it('detaches a tag that was commissioned by EPC alone', async () => {
    const res = await request(ctx.app).delete('/api/boxes/BOX-E1/rfid').set(auth(ctx.token));
    expect(res.status).toBe(200);
    const box = await request(ctx.app).get('/api/boxes/BOX-E1').set(auth(ctx.token));
    expect(box.body.rfidEpc).toBeNull();
  });
});
