import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await bootstrap();
});

const beat = (body: object) => request(ctx.app).post('/api/devices/heartbeat').set(auth(ctx.token)).send(body);
const list = async () => (await request(ctx.app).get('/api/devices').set(auth(ctx.token))).body.devices;

describe('PDA presence', () => {
  it('shows a handheld that identifies itself only by its login', async () => {
    const res = await beat({ name: 'TC52', model: 'TC52', warehouseId: 'WH-001', gateNo: 2, usesZebraSdk: true });
    expect(res.status).toBe(200);
    expect(await list()).toEqual([
      expect.objectContaining({ name: 'TC52', warehouse: 'WH-001', gate: '2', online: true }),
    ]);
    await beat({ name: 'TC52' });
    expect(await list()).toHaveLength(1);
  });

  it('still accepts a handheld that sends its own id', async () => {
    const res = await beat({ deviceId: 'PDA-9', name: 'old', warehouse: 'WH-002', gate: '1' });
    expect(res.status).toBe(200);
    expect(await list()).toContainEqual(expect.objectContaining({ deviceId: 'PDA-9', warehouse: 'WH-002', gate: '1' }));
  });

  it('reports who is using the handheld and what it is, until they sign out', async () => {
    const info = { model: 'TC52', ipAddress: '192.168.3.115', hasIntegratedRfid: false, usesZebraSdk: true };
    await beat({ deviceId: 'PDA-U', name: 'TC52', ...info, employeeId: 'EMP-001', employeeName: 'สมชาย' });
    const find = async () => (await list()).find((d: { deviceId: string }) => d.deviceId === 'PDA-U');
    expect(await find()).toMatchObject({ ...info, employeeId: 'EMP-001', employeeName: 'สมชาย' });
    await beat({ deviceId: 'PDA-U', name: 'TC52', ...info });
    expect((await find()).employeeName).toBeUndefined();
  });

  it('turns offline after three missed reports of its own interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.now();
      await beat({ deviceId: 'FAST', name: 'a', heartbeatSeconds: 5 });
      await beat({ deviceId: 'SLOW', name: 'b' });
      const online = async () => Object.fromEntries((await list()).map((d: { deviceId: string; online: boolean }) => [d.deviceId, d.online]));
      vi.setSystemTime(start + 14_000);
      expect(await online()).toMatchObject({ FAST: true, SLOW: true });
      vi.setSystemTime(start + 16_000);
      expect(await online()).toMatchObject({ FAST: false, SLOW: true });
      vi.setSystemTime(start + 46_000);
      expect(await online()).toMatchObject({ SLOW: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires a login', async () => {
    expect((await request(ctx.app).post('/api/devices/heartbeat').send({ name: 'x' })).status).toBe(401);
  });
});
