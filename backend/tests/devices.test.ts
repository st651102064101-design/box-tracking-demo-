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
    await beat({ name: 'TC52', model: 'TC52', warehouseId: 'WH-001', gateNo: 2, usesZebraSdk: true });
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

describe('PDA screen state', () => {
  it('shows a sleeping handheld as sleeping, not offline, and clears it on the next report', async () => {
    await beat({ deviceId: 'PDA-SLEEP', name: 'sleepy', heartbeatSeconds: 5 });
    await beat({ deviceId: 'PDA-SLEEP', name: 'sleepy', heartbeatSeconds: 5, sleeping: true });
    let dev = (await list()).find((d: { deviceId: string }) => d.deviceId === 'PDA-SLEEP');
    expect(dev).toEqual(expect.objectContaining({ state: 'sleeping', online: false }));
    await beat({ deviceId: 'PDA-SLEEP', name: 'sleepy', heartbeatSeconds: 5 });
    dev = (await list()).find((d: { deviceId: string }) => d.deviceId === 'PDA-SLEEP');
    expect(dev).toEqual(expect.objectContaining({ state: 'online', online: true }));
  });

  it('gives up on a sleeping handheld after the sleep window', async () => {
    const { deviceState } = await import('../src/routes/devices.js');
    const d = { deviceId: 'x', name: 'x', kind: 'pda', warehouse: '', gate: '', sleeping: true, lastSeenAt: new Date(0).toISOString() } as const;
    expect(deviceState(d as never, 5 * 60_000)).toBe('sleeping');
    expect(deviceState(d as never, 11 * 60_000)).toBe('offline');
  });
});

describe('two handhelds on one login', () => {
  it('keeps a TC52 and an MC3390R apart when they share the login', async () => {
    await beat({ name: 'Zebra TC52', model: 'tc52', warehouseId: 'WH-001', gateNo: 1 });
    await beat({ name: 'Zebra MC3390R', model: 'mc3390r', warehouseId: 'WH-001', gateNo: 1 });
    const names = (await list()).map((d: { name: string }) => d.name);
    expect(names).toEqual(expect.arrayContaining(['Zebra TC52', 'Zebra MC3390R']));
  });
});
