/**
 * Shared "demo plant" for the workflow tests: two warehouses, one gate of every
 * kind, and one helper per thing a real device or screen does.
 */
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { bootstrap, auth, type TestCtx } from '../helpers.js';
import { getDb } from '../../src/db/client.js';
import { boxes, rfidAntennaGateMappings, rfidReaders } from '../../src/db/schema.js';
import { env } from '../../src/env.js';

export const GATE = { in: 1, out: 2, screen: 3, antenna: 4, otherWh: 9 } as const;

export async function makeWorld() {
  const ctx: TestCtx = await bootstrap();
  const api = () => request(ctx.app);
  const as = auth(ctx.token);

  const w = {
    ctx,
    api,
    as,
    state: async () => (await api().get('/api/state').set(as)).body,
    save: (state: object) => api().put('/api/state').set(as).send(state),
    row: async (tag: string) => (await getDb().select().from(boxes).where(eq(boxes.tag, tag)))[0],
    dirs: async (tag: string) => ((await w.row(tag)).history as { dir: string }[]).map((h) => h.dir),
    events: async (tag: string) =>
      ((await w.state()).events as { tag?: string; dir: string }[]).filter((e) => e.tag === tag).map((e) => e.dir),

    register: (tag: string) => api().post('/api/boxes').set(as).send({ tag, type: 'BT' }),
    label: (tag: string) => api().post(`/api/boxes/${tag}/label`).set(as).send({}),
    putaway: (tag: string, wh = 'WH-1', extra: object = {}) =>
      api().post(`/api/boxes/${tag}/putaway`).set(as).send({ wh, ...extra }),
    out: (tags: string[], gate: number = GATE.out, extra: object = {}) =>
      api().post('/api/gate/out').set(as).send({ tags, gate, customer: 'C1', ...extra }),
    in: (tags: string[], gate: number = GATE.in, extra: object = {}) =>
      api().post('/api/gate/in').set(as).send({ tags, gate, ...extra }),
    hold: (tag: string, status: 'hold' | 'damage' | 'warehouse') =>
      api().post(`/api/boxes/${tag}/hold`).set(as).send({ status, reason: 'qa' }),
    /** A box registered, labelled and standing in `wh`. */
    async stocked(tag: string, wh = 'WH-1') {
      for (const step of [() => w.register(tag), () => w.label(tag), () => w.putaway(tag, wh)]) {
        const res = await step();
        if (res.status !== 200) throw new Error(`setup ${tag}: ${res.status} ${JSON.stringify(res.body)}`);
      }
    },

    epc: async (tag: string): Promise<string> => (await api().get(`/api/rfid/encode/${tag}`).set(as)).body.epcHex,
    /** What the fixed FX9600 reader posts. */
    async read(gate: number, tags: string[], antenna?: number) {
      const body = [];
      for (const tag of tags) body.push({ idHex: await w.epc(tag), ...(antenna ? { antenna } : {}) });
      return api().post(`/api/rfid/fx9600/${gate}/webhook`).set('X-Webhook-Secret', env.fx9600WebhookSecret).send(body);
    },
    session: (gate: number, extra: object = {}) =>
      api().put(`/api/rfid/gates/${gate}/auto-session`).set(as).send({ direction: 'out', customer: 'C1', ...extra }),
    pending: async (gate: number): Promise<string[]> => (await api().get(`/api/rfid/pending/${gate}`).set(as)).body.tags,
    camera: (gate: number, plateNumber: string, extra: object = {}) =>
      api().post('/api/gate/lpr').set('X-LPR-Webhook-Secret', env.lprWebhookSecret).send({
        eventId: `ev-${gate}-${plateNumber}-${Math.random()}`, cameraId: 'cam', plateNumber, confidence: 0.99,
        gateId: gate, timestamp: new Date().toISOString(), vehicleColor: 'white', direction: 'outbound', ...extra,
      }),
  };

  const warehouse = (id: string, gates: number[], gateTypes: Record<string, string>) =>
    ({ id, name: id, gates, gateTypes, gateBidirectionalModes: { [GATE.antenna]: 'antenna' } });
  const res = await w.save({
    boxtypes: { BT: { id: 'BT', name: 'box', value: 100 }, 'BT-OLD': { id: 'BT-OLD', name: 'retired', value: 1 } },
    customers: { C1: { id: 'C1', name: 'one', returnDays: 7 }, C2: { id: 'C2', name: 'two', returnDays: 30 }, C3: { id: 'C3', name: 'leaving' } },
    warehouses: {
      'WH-1': warehouse('WH-1', [1, 2, 3, 4], { 1: 'in', 2: 'out', 3: 'both', 4: 'both' }),
      'WH-2': warehouse('WH-2', [9], { 9: 'both' }),
    },
    gates: { 1: 'WH-1', 2: 'WH-1', 3: 'WH-1', 4: 'WH-1', 9: 'WH-2' },
    employees: {
      'E-ON': { id: 'E-ON', name: 'on duty', status: 'active' },
      'E-OFF': { id: 'E-OFF', name: 'left', status: 'inactive' },
    },
  });
  if (res.status !== 200) throw new Error(`world: ${JSON.stringify(res.body)}`);

  await getDb().insert(rfidReaders).values({
    id: 'R-ANT', name: 'antenna gate', host: 'h', gateNo: GATE.antenna, webhookUrl: 'http://x', transmitPower: '3', antennaCount: 2,
  });
  await getDb().insert(rfidAntennaGateMappings).values([
    { readerId: 'R-ANT', antennaPort: 1, gateNo: GATE.antenna, antennaRole: 'outer' },
    { readerId: 'R-ANT', antennaPort: 2, gateNo: GATE.antenna, antennaRole: 'inner' },
  ]);
  return w;
}

export type World = Awaited<ReturnType<typeof makeWorld>>;
