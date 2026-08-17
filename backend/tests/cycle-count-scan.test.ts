/**
 * ตรวจนับ (cycle count) — the two things that made it look broken on the floor:
 * the expected list excluding boxes that were never put away to a rack, and a
 * raw ASCII-encoded EPC not resolving to the box whose barcode it carries.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { boxes } from '../src/db/schema.js';
import { epcToAscii, epcTagCandidates } from '../src/lib/epcCodec.js';

let ctx: TestCtx;

/** What GET /api/rfid/encode/:tag writes: the barcode as ASCII, right-aligned
 *  and zero-padded to 96 bits / 24 hex chars. */
function encodeEpc(tag: string, hexWidth = 28): string {
  const ascii = Buffer.from(tag, 'ascii').toString('hex').toUpperCase();
  return ascii.padStart(hexWidth, '0');
}

beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  const now = new Date();
  await db.insert(boxes).values([
    // Received through the gate, never put away — no wh/zone recorded at all.
    // This is the shape almost every real box was in.
    {
      tag: 'BOX-010',
      type: 'BT-1',
      status: 'warehouse',
      location: {},
      data: { tag: 'BOX-010', status: 'warehouse' },
      updatedAt: now,
    },
    {
      tag: 'CRT-01',
      type: 'BT-1',
      status: 'warehouse',
      location: { wh: '', zone: '' },
      data: { tag: 'CRT-01', status: 'warehouse' },
      updatedAt: now,
    },
    // Properly shelved in the warehouse being counted.
    {
      tag: 'BOX-011',
      type: 'BT-1',
      status: 'warehouse',
      location: { wh: 'WH-001', zone: 'A' },
      data: { tag: 'BOX-011', status: 'warehouse' },
      updatedAt: now,
    },
    // Shelved somewhere else — must NOT be expected here.
    {
      tag: 'BOX-012',
      type: 'BT-1',
      status: 'warehouse',
      location: { wh: 'WH-002', zone: 'A' },
      data: { tag: 'BOX-012', status: 'warehouse' },
      updatedAt: now,
    },
    // Out with a customer — not on the shelves at all.
    {
      tag: 'BOX-013',
      type: 'BT-1',
      status: 'out',
      location: { wh: 'WH-001', zone: 'A' },
      data: { tag: 'BOX-013', status: 'out' },
      updatedAt: now,
    },
  ]);
});

describe('hex EPC -> ASCII barcode', () => {
  it('decodes what the encoder writes, and rejects what carries no text', () => {
    expect(epcToAscii('00000000000000424F582D303130')).toBe('BOX-010');
    // '0'-padded (0x30) rather than 0x00 — the zeros decode as text, so the
    // candidate list is what has to find the real id.
    expect(epcTagCandidates(encodeEpc('00000CRT-01'))).toContain('CRT-01');
    // A plain numeric EPC has no barcode in it.
    expect(epcToAscii('E28011606000020000000001')).toBeNull();
  });
});

describe('a count expects the boxes that are actually in the warehouse', () => {
  it('includes boxes with no location recorded, and excludes other warehouses', async () => {
    const res = await request(ctx.app)
      .post('/api/cycle-counts')
      .set(auth(ctx.token))
      .send({ wh: 'WH-001', zone: 'A' });
    expect(res.status).toBe(201);

    const expected: string[] = res.body.expected;
    // Never put away — the case that used to be silently dropped.
    expect(expected).toContain('BOX-010');
    expect(expected).toContain('CRT-01');
    // Shelved right here.
    expect(expected).toContain('BOX-011');
    // Another warehouse, and one that isn't on a shelf at all.
    expect(expected).not.toContain('BOX-012');
    expect(expected).not.toContain('BOX-013');
  });
});

describe('scanning a tag counts the box it belongs to', () => {
  it('counts a raw ASCII-encoded EPC even though no tag was ever bound', async () => {
    const open = await request(ctx.app)
      .post('/api/cycle-counts')
      .set(auth(ctx.token))
      .send({ wh: 'WH-001', zone: '' });
    const id = open.body.id;

    const db = getDb();
    const [box] = await db.select().from(boxes);
    expect(box.rfidEpc).toBeNull(); // nothing bound — the normal state

    const res = await request(ctx.app)
      .post(`/api/cycle-counts/${id}/scan`)
      .set(auth(ctx.token))
      .send({ tags: ['00000000000000424F582D303130', encodeEpc('00000CRT-01')] });

    expect(res.status).toBe(200);
    expect(res.body.unknown).toEqual([]);
    expect(res.body.counted).toContain('BOX-010');
    expect(res.body.counted).toContain('CRT-01');
    expect(res.body.unexpected).toEqual([]);
  });

  it('still reports a genuinely unknown tag rather than swallowing it', async () => {
    const open = await request(ctx.app)
      .post('/api/cycle-counts')
      .set(auth(ctx.token))
      .send({ wh: 'WH-009', zone: '' });
    const res = await request(ctx.app)
      .post(`/api/cycle-counts/${open.body.id}/scan`)
      .set(auth(ctx.token))
      .send({ tags: ['E28011606000020000000001', encodeEpc('NOPE-99')] });
    expect(res.body.unknown).toHaveLength(2);
    expect(res.body.counted).toEqual([]);
  });
});
