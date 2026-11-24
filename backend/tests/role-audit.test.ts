import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { asc, like } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { auditLog } from '../src/db/schema.js';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

async function roleAuditRows() {
  return getDb().select().from(auditLog).where(like(auditLog.entityId, 'ROLE-%')).orderBy(asc(auditLog.id));
}

describe('role changes are written to the audit log', () => {
  let roleId: number;

  it('logs a create with the actor and role name', async () => {
    const res = await request(ctx.app)
      .post('/api/roles')
      .set(auth(ctx.token))
      .send({ name: 'Audit QA', description: 'first', permissions: [] });
    expect(res.status).toBe(201);
    roleId = res.body.id;

    const rows = await roleAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'create',
      actor: 'admin',
      entityId: `ROLE-${roleId}`,
      entityName: 'Audit QA',
    });
  });

  it('logs an update with the before and after values', async () => {
    const res = await request(ctx.app)
      .put(`/api/roles/${roleId}`)
      .set(auth(ctx.token))
      .send({ name: 'Audit QA 2', description: 'second' });
    expect(res.status).toBe(200);

    const rows = await roleAuditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: 'update', entityId: `ROLE-${roleId}`, entityName: 'Audit QA 2' });
    expect(rows[1].before).toMatchObject({ name: 'Audit QA', description: 'first' });
    expect(rows[1].after).toMatchObject({ name: 'Audit QA 2', description: 'second' });
  });

  it('logs a delete', async () => {
    const res = await request(ctx.app).delete(`/api/roles/${roleId}`).set(auth(ctx.token));
    expect(res.status).toBe(200);

    const rows = await roleAuditRows();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ action: 'delete', entityId: `ROLE-${roleId}`, entityName: 'Audit QA 2' });
    expect(rows[2].after).toBeNull();
  });

  it('does not log a create that was rejected', async () => {
    const before = (await roleAuditRows()).length;
    const res = await request(ctx.app).post('/api/roles').set(auth(ctx.token)).send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(await roleAuditRows()).toHaveLength(before);
  });
});
