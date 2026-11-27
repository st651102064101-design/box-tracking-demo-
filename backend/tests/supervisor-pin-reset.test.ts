import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, type TestCtx } from './helpers.js';
import { getDb } from '../src/db/client.js';
import { employees } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
  const db = getDb();
  await db.insert(employees).values([
    { id: 'EMP-STAFF', name: 'Worker', role: 'staff', data: { scanCode: 'WRK-0001' } },
    { id: 'EMP-SUP', name: 'Supervisor', role: 'admin', data: { scanCode: 'SUP-0001' } },
    { id: 'EMP-PLAIN', name: 'Plain', role: 'staff', data: {} },
  ]).onConflictDoNothing();
});

const reset = (body: object) => request(ctx.app).post('/api/pda/pin-reset-approved').send(body);

describe('PIN reset approved by a supervisor on the handheld', () => {
  it('resets when the employee card and a supervisor card are scanned', async () => {
    const res = await reset({ employeeCard: 'WRK-0001', supervisorCard: 'SUP-0001', pin: '4821' });
    expect(res.status).toBe(200);
    const [row] = await getDb().select().from(employees).where(eq(employees.id, 'EMP-STAFF'));
    expect(row.pinHash).toBeTruthy();
  });

  it('refuses when the supervisor card belongs to someone without the permission', async () => {
    const res = await reset({ employeeCard: 'WRK-0001', supervisorCard: 'EMP-PLAIN', pin: '4821' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reset_denied');
  });

  it('refuses an unknown card, and refuses a person approving their own reset', async () => {
    expect((await reset({ employeeCard: 'NOPE', supervisorCard: 'SUP-0001', pin: '4821' })).status).toBe(400);
    expect((await reset({ employeeCard: 'SUP-0001', supervisorCard: 'SUP-0001', pin: '4821' })).status).toBe(400);
  });

  it('needs a 4-digit PIN', async () => {
    expect((await reset({ employeeCard: 'WRK-0001', supervisorCard: 'SUP-0001', pin: '12' })).status).toBe(400);
  });
});
