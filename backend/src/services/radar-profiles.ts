import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { appSettings, boxes } from '../db/schema.js';
import { decodeEpcHexToBarcode, looksLikeHex } from '../lib/rfid.js';
import { httpError } from '../middleware/error.js';

export const radarInput = z.object({
  epc: z.string().trim().min(1).max(256).transform(v => v.toUpperCase()),
  tag: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(80).transform(v => v.toUpperCase()),
  powerPercent: z.number().int().min(0).max(100),
  readerProfile: z.enum(['fast', 'radar']).default('fast'),
  tid: z.string().regex(/^[0-9a-fA-F]{8,128}$/).transform(v => v.toUpperCase()).optional(),
  referenceRssi: z.number().int().min(-120).max(-1).optional(),
  weakestRssi: z.number().int().min(-120).max(-1).optional(),
});
export type RadarInput = z.infer<typeof radarInput>;
type Profile = { epc?: string; tid?: string; family?: string; referenceRssi?: number; weakestRssi?: number; model: string; powerPercent: number; readerProfile?: string };
const key = (kind: string, identity: string, input: Pick<RadarInput, 'model' | 'powerPercent' | 'readerProfile'>) =>
  `radar:${kind}:${createHash('sha256').update(JSON.stringify([identity, input.model, input.powerPercent, input.readerProfile])).digest('hex')}`;
const identityKey = (epc: string) => `radar:identity:${createHash('sha256').update(epc).digest('hex')}`;
// E2 TID's first 32 bits identify chip/capability family, not the inlay antenna.
export const tidFamily = (tid?: string) => tid && /^E2[0-9A-F]{6}/i.test(tid) ? tid.slice(0, 8).toUpperCase() : undefined;
async function read(key: string): Promise<Profile | undefined> {
  const [row] = await getDb().select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row?.data as Profile | undefined;
}
export async function radarProfile(input: Pick<RadarInput, 'epc' | 'model' | 'powerPercent' | 'readerProfile'>) {
  const own = await read(key('tag', input.epc, input));
  const identity = await read(identityKey(input.epc));
  const family = identity?.family ?? own?.family;
  const group = family ? await read(key('family', family, input)) : undefined;
  const ownReference = own?.family && family !== own.family ? undefined : own?.referenceRssi;
  return { ...own, tid: identity?.tid ?? own?.tid, family, referenceRssi: ownReference ?? group?.referenceRssi,
    source: ownReference != null ? 'tag' : group?.referenceRssi != null ? 'family' : 'default' };
}
export async function saveRadarObservation(input: RadarInput) {
  const db = getDb();
  const [box] = await db.select().from(boxes).where(eq(boxes.tag, input.tag)).limit(1);
  let decoded = input.epc;
  if (looksLikeHex(input.epc)) decoded = decodeEpcHexToBarcode(input.epc);
  const matches = box && [box.tag, box.rfid, box.rfidEpc, box.rfidTid]
    .some(v => v && (v.toUpperCase() === input.epc || v.toUpperCase() === decoded.replace(/^0+/, '')));
  if (!matches) throw httpError(404, 'แท็กไม่ตรงกับกล่องในระบบ', 'unknown_rfid');
  // Transaction serialises same-EPC writers. Profiles survive full-state sync.
  return db.transaction(async tx => {
    const k = key('tag', input.epc, input);
    await tx.insert(appSettings).values({ key: k, data: {} }).onConflictDoNothing();
    const [row] = await tx.select().from(appSettings).where(eq(appSettings.key, k)).for('update');
    const old = row.data as Profile;
    const [identityRow] = await tx.select().from(appSettings).where(eq(appSettings.key, identityKey(input.epc))).limit(1);
    const identity = identityRow?.data as Profile | undefined;
    const family = tidFamily(input.tid) ?? identity?.family ?? old.family;
    const data: Profile = { ...old, epc: input.epc, model: input.model, powerPercent: input.powerPercent, readerProfile: input.readerProfile,
      ...(input.tid ? { tid: input.tid } : {}), ...(family ? { family } : {}),
      ...(input.referenceRssi != null ? { referenceRssi: input.referenceRssi } : {}),
      ...(input.weakestRssi != null ? { weakestRssi: Math.min(old.weakestRssi ?? input.weakestRssi, input.weakestRssi) } : {}) };
    if (old.family && family !== old.family) {
      delete data.referenceRssi;
      delete data.weakestRssi;
      if (input.referenceRssi != null) data.referenceRssi = input.referenceRssi;
      if (input.weakestRssi != null) data.weakestRssi = input.weakestRssi;
    }
    await tx.update(appSettings).set({ data, updatedAt: new Date() }).where(eq(appSettings.key, k));
    if (input.tid) await tx.insert(appSettings).values({ key: identityKey(input.epc), data: { tid: input.tid, family } })
      .onConflictDoUpdate({ target: appSettings.key, set: { data: { tid: input.tid, family }, updatedAt: new Date() } });
    if (family && input.referenceRssi != null) {
      await tx.insert(appSettings).values({ key: key('family', family, input), data: { model: input.model, powerPercent: input.powerPercent, referenceRssi: input.referenceRssi } })
        .onConflictDoNothing(); // First voluntary calibration supplies the family default.
    }
    return data;
  });
}
