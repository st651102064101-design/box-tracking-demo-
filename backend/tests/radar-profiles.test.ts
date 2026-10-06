import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootstrap, auth, type TestCtx } from './helpers.js';
import { radarInput, tidFamily } from '../src/services/radar-profiles.js';
let ctx: TestCtx;
const base = { tag: 'BOX-A', epc: '0000424F582D41', model: 'MC3390R', powerPercent: 100 };
const observe = (data: object) => request(ctx.app).post('/api/rfid/radar/observe').set(auth(ctx.token)).send({ observations: [data] });
const profile = (epc = base.epc, model = base.model, powerPercent = 100) => request(ctx.app).get('/api/rfid/radar/profile').set(auth(ctx.token)).query({ epc, model, powerPercent });
beforeAll(async () => {
  ctx = await bootstrap();
  await request(ctx.app).put('/api/state').set(auth(ctx.token)).send({ boxes: {
    'BOX-A': { tag: 'BOX-A', type: 'BT-001', status: 'warehouse', history: [] },
    'BOX-B': { tag: 'BOX-B', type: 'BT-001', status: 'warehouse', history: [] },
  } });
});
describe('radar DB learning without tag association', () => {
  it('rejects unknown EPC, spoofed box, missing auth and invalid measurements', async () => {
    expect((await observe({ ...base, epc: 'UNKNOWN' })).status).toBe(404);
    expect((await observe({ ...base, tag: 'BOX-B' })).status).toBe(404);
    expect((await observe({ ...base, referenceRssi: 0 })).status).toBe(400);
    expect((await request(ctx.app).get('/api/rfid/radar/profile').query(base)).status).toBe(401);
    expect(radarInput.safeParse({ ...base, powerPercent: 101 }).success).toBe(false);
  });
  it('records first EPC and TID automatically, retains weakest observed signal', async () => {
    expect((await observe({ ...base, tid: 'E28011900001', weakestRssi: -90 })).status).toBe(200);
    await observe({ ...base, weakestRssi: -60 });
    const result = (await profile()).body;
    expect(result.tid).toBe('E28011900001'); expect(result.weakestRssi).toBe(-90);
    expect(result.source).toBe('default');
  });
  it('voluntary reference becomes family default, exact-tag reference wins', async () => {
    await observe({ ...base, referenceRssi: -65 });
    const b = { ...base, tag: 'BOX-B', epc: '0000424F582D42', tid: 'E28011909999' };
    await observe(b);
    expect((await profile(b.epc)).body).toMatchObject({ referenceRssi: -65, source: 'family' });
    await observe({ ...b, referenceRssi: -72 });
    expect((await profile(b.epc)).body).toMatchObject({ referenceRssi: -72, source: 'tag' });
    expect((await profile(base.epc, 'TC501')).body.source).toBe('default');
    expect((await profile(base.epc, base.model, 50)).body.source).toBe('default');
    expect(tidFamily('E200341100AA')).not.toBe(tidFamily('E28011900001'));
    expect(tidFamily('BAD')).toBeUndefined();
  });
  it('full-state sync does not erase calibration', async () => {
    const state = await request(ctx.app).get('/api/state').set(auth(ctx.token));
    await request(ctx.app).put('/api/state').set(auth(ctx.token)).send(state.body);
    expect((await profile()).body.referenceRssi).toBe(-65);
  });
  it('TID learned at a fast gate is reused by radar, but fast and radar anchors stay separate', async () => {
    await observe({ ...base, readerProfile: 'radar', referenceRssi: -80 });
    const radar = await request(ctx.app).get('/api/rfid/radar/profile').set(auth(ctx.token)).query({
      epc: '0000424F582D42', model: base.model, powerPercent: 100, readerProfile: 'radar' });
    expect(radar.body).toMatchObject({ source: 'family', referenceRssi: -80, tid: 'E28011909999' });
    expect((await profile()).body.referenceRssi).toBe(-65);
  });
  it('a changed chip family invalidates the previous physical-tag calibration', async () => {
    await observe({ ...base, tid: 'E20034110001', weakestRssi: -70 });
    expect((await profile()).body).toMatchObject({ source: 'default', weakestRssi: -70 });
    expect((await profile()).body.referenceRssi).toBeUndefined();
  });
});
