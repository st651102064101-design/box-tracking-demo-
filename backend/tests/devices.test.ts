import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await bootstrap();
});

describe('handheld device presence', () => {
  it('stores the model and RFID capability on heartbeat', async () => {
    const res = await request(ctx.app)
      .post('/api/devices/heartbeat')
      .set(auth(ctx.token))
      .send({
        name: 'Zebra TC501',
        model: 'tc501',
        warehouseId: 'WH-1',
        gateNo: 2,
        hasIntegratedRfid: true,
        usesZebraSdk: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.device.model).toBe('tc501');
    expect(res.body.device.hasIntegratedRfid).toBe(true);
    expect(res.body.device.usesZebraSdk).toBe(true);
    expect(res.body.device.warehouse).toBe('WH-1');
    expect(res.body.device.gate).toBe(2);
  });

  it('returns the stored profile to the same service account', async () => {
    const res = await request(ctx.app).get('/api/devices/me').set(auth(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.device.model).toBe('tc501');
    expect(res.body.device.hasIntegratedRfid).toBe(true);
    expect(res.body.device.name).toBe('Zebra TC501');
  });

  it('keeps RFID capability when a later heartbeat omits it', async () => {
    const res = await request(ctx.app)
      .post('/api/devices/heartbeat')
      .set(auth(ctx.token))
      .send({ name: 'Zebra TC501', model: 'tc501', warehouseId: 'WH-1' });
    expect(res.status).toBe(200);
    expect(res.body.device.hasIntegratedRfid).toBe(true);
    expect(res.body.device.usesZebraSdk).toBe(true);
  });

  it('lists stored capability on the dashboard feed', async () => {
    const res = await request(ctx.app).get('/api/devices').set(auth(ctx.token));
    expect(res.status).toBe(200);
    const mine = res.body.devices.find((d: { id: string }) => d.id === 'admin');
    expect(mine.hasIntegratedRfid).toBe(true);
    expect(mine.model).toBe('tc501');
  });
});
