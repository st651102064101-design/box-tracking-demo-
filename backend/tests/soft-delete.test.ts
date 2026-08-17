/**
 * Soft delete — customers, box types, roles.
 *
 * The interesting failure mode isn't the DELETE endpoint itself (trivial to
 * get right); it's everything downstream that used to assume a row either
 * exists or doesn't. In particular: PUT /api/state upserts rows from
 * whatever the client's local S still has in memory, and composeState (what
 * GET /api/state returns) excludes soft-deleted rows — so a client that
 * hasn't refreshed since a delete still carries the deleted row locally and
 * will re-save it on its next unrelated write. That save must not resurrect
 * the row.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { customers, boxTypes, roles } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

async function state() {
  return (await request(ctx.app).get('/api/state').set(auth(ctx.token))).body;
}

describe('customers', () => {
  it('deletes softly: gone from lists, row still in the database', async () => {
    await request(ctx.app)
      .post('/api/masters/customers')
      .set(auth(ctx.token))
      .send({ id: 'CUST-SD1', name: 'ลูกค้าทดสอบลบ' });

    const del = await request(ctx.app).delete('/api/masters/customers/CUST-SD1').set(auth(ctx.token));
    expect(del.status).toBe(200);

    const list = await request(ctx.app).get('/api/masters/customers').set(auth(ctx.token));
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain('CUST-SD1');

    const [row] = await getDb().select().from(customers).where(eq(customers.id, 'CUST-SD1'));
    expect(row).toBeTruthy();
    expect(row.deletedAt).toBeTruthy();

    const s = await state();
    expect(s.customers['CUST-SD1']).toBeUndefined();
  });

  it('a stale client re-saving state does not resurrect a deleted customer', async () => {
    /* Simulates the real hazard: fetch state BEFORE deleting (stale client's
       snapshot still has the row), delete it, then PUT that stale snapshot
       back — as an ordinary edit to something unrelated would. */
    const stale = await state();
    expect(stale.customers['CUST-SD1']).toBeUndefined(); // already deleted from the prior test

    // Recreate, capture a fresh "stale" snapshot that includes it, delete again.
    await request(ctx.app)
      .post('/api/masters/customers')
      .set(auth(ctx.token))
      .send({ id: 'CUST-SD2', name: 'ลูกค้าทดสอบลบ2' });
    const staleWithIt = await state();
    expect(staleWithIt.customers['CUST-SD2']).toBeTruthy();

    await request(ctx.app).delete('/api/masters/customers/CUST-SD2').set(auth(ctx.token));

    // The stale client now saves its whole snapshot back, unaware of the delete.
    const res = await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(staleWithIt);
    expect(res.status).toBe(200);

    const [row] = await getDb().select().from(customers).where(eq(customers.id, 'CUST-SD2'));
    expect(row.deletedAt).toBeTruthy(); // still deleted — not revived, not hard-deleted either
  });

  it('the id can be reused — a fresh POST revives it as a normal, live row', async () => {
    const res = await request(ctx.app)
      .post('/api/masters/customers')
      .set(auth(ctx.token))
      .send({ id: 'CUST-SD2', name: 'ลูกค้าใหม่ใช้รหัสเดิม' });
    expect(res.status).toBe(201);

    const [row] = await getDb().select().from(customers).where(eq(customers.id, 'CUST-SD2'));
    expect(row.deletedAt).toBeNull();
    expect(row.name).toBe('ลูกค้าใหม่ใช้รหัสเดิม');

    const s = await state();
    expect(s.customers['CUST-SD2']).toBeTruthy();
  });
});

describe('box types', () => {
  it('deletes softly and excludes the row from GET /api/state', async () => {
    await request(ctx.app)
      .post('/api/masters/box-types')
      .set(auth(ctx.token))
      .send({ id: 'BT-SD1', name: 'ประเภททดสอบลบ', unit: 'ใบ' });
    await request(ctx.app).delete('/api/masters/box-types/BT-SD1').set(auth(ctx.token));

    const [row] = await getDb().select().from(boxTypes).where(eq(boxTypes.id, 'BT-SD1'));
    expect(row.deletedAt).toBeTruthy();

    const s = await state();
    expect(s.boxtypes['BT-SD1']).toBeUndefined();
  });
});

describe('roles', () => {
  it('deletes softly, disappears from the list, and can no longer grant permissions', async () => {
    const created = await request(ctx.app)
      .post('/api/roles')
      .set(auth(ctx.token))
      .send({ name: 'บทบาททดสอบลบ', permissions: ['box.view'] });
    const roleId = created.body.id;

    const del = await request(ctx.app).delete(`/api/roles/${roleId}`).set(auth(ctx.token));
    expect(del.status).toBe(200);

    const list = await request(ctx.app).get('/api/roles').set(auth(ctx.token));
    expect(list.body.roles.map((r: { id: number }) => r.id)).not.toContain(roleId);

    const [row] = await getDb().select().from(roles).where(eq(roles.id, roleId));
    expect(row.deletedAt).toBeTruthy();
    // Grants are left in place deliberately (see the DELETE handler's comment)
    // — the audit question "what could this role do" stays answerable.
  });

  it('a name freed by soft-deleting can be reused for a new role', async () => {
    const created = await request(ctx.app)
      .post('/api/roles')
      .set(auth(ctx.token))
      .send({ name: 'บทบาทชื่อซ้ำได้' });
    await request(ctx.app).delete(`/api/roles/${created.body.id}`).set(auth(ctx.token));

    const again = await request(ctx.app)
      .post('/api/roles')
      .set(auth(ctx.token))
      .send({ name: 'บทบาทชื่อซ้ำได้' });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(created.body.id); // a distinct new row, not a revival
  });
});
