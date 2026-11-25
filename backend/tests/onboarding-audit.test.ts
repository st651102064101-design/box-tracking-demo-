import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { auditLog, users } from '../src/db/schema.js';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
  await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.username, 'admin'));
});

const setup = {
  name: 'ผู้ดูแล ทดสอบ',
  email: 'owner@example.com',
  username: 'EMP-001',
  password: 'Strong#Pass12',
  phone: '0812345678',
  department: 'คลังสินค้า',
  warehouse: 'WH-1',
};

/* The onboarding page tells the operator "ระบบจะบันทึกทุกขั้นตอนใน Audit Log", but
   completing first-time setup wrote nothing. */
describe('POST /api/auth/first-setup is audited', () => {
  it('writes one credentials_set entry describing the change, never the password', async () => {
    const before = await getDb().select().from(auditLog);

    const res = await request(ctx.app).post('/api/auth/first-setup').set(auth(ctx.token)).send(setup);
    expect(res.status).toBe(200);

    const rows = (await getDb().select().from(auditLog).orderBy(asc(auditLog.id))).slice(before.length);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'credentials_set', actor: 'EMP-001', entityId: 'EMP-001' });
    expect(rows[0].before).toMatchObject({ username: 'admin' });
    expect(rows[0].after).toMatchObject({ username: 'EMP-001', email: 'owner@example.com' });

    const everything = JSON.stringify(rows[0]);
    expect(everything).not.toContain(setup.password);
    expect(everything.toLowerCase()).not.toContain('passwordhash');
  });

  it('writes nothing when setup was already done (rejected with 409)', async () => {
    const before = (await getDb().select().from(auditLog)).length;
    const again = await request(ctx.app).post('/api/auth/first-setup').set(auth(ctx.token)).send(setup);
    expect(again.status).toBe(409);
    expect((await getDb().select().from(auditLog)).length).toBe(before);
  });
});
