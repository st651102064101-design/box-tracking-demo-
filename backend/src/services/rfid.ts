/**
 * RFID tag commissioning + flexible scan resolution.
 *
 * A box's permanent identity is always `boxes.tag` (the barcode). RFID is an
 * additional way to *find* that same row — gate.ts and boxes.ts both resolve
 * an incoming scan against tag/rfid_epc/rfid_tid via {@link resolveBoxesByCodes}
 * before doing anything else, so the rest of the system never has to know or
 * care whether an operator scanned a barcode or an RFID tag.
 */
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { boxes } from '../db/schema.js';
import { httpError } from '../middleware/error.js';
import { writeAuditLog } from './audit.js';

type BoxRow = typeof boxes.$inferSelect;

export interface ResolveResult {
  /** Scanned code -> the box row it matched, however it matched. */
  resolved: Map<string, BoxRow>;
  /** Scanned codes that matched nothing (tag, EPC, or TID). */
  missing: string[];
}

/**
 * Resolves a batch of scanned codes (barcodes and/or RFID reads, mixed
 * freely) against boxes.{tag,rfid_epc,rfid_tid} in one query.
 *
 * A code is checked against all three columns independently — it's still
 * correct even though the query itself is a single batched `OR (tag IN …
 * OR rfid_epc IN … OR rfid_tid IN …)` across every candidate row.
 */
export async function resolveBoxesByCodes(db: DB, codes: string[]): Promise<ResolveResult> {
  const uniq = Array.from(new Set(codes));
  const rows = uniq.length
    ? await db
        .select()
        .from(boxes)
        .where(
          or(
            inArray(boxes.tag, uniq),
            inArray(boxes.rfid, uniq),
            inArray(boxes.rfidEpc, uniq),
            inArray(boxes.rfidTid, uniq),
          ),
        )
    : [];

  const resolved = new Map<string, BoxRow>();
  const missing: string[] = [];
  for (const code of uniq) {
    const row = rows.find(
      (r) => r.tag === code || r.rfid === code || r.rfidEpc === code || r.rfidTid === code,
    );
    if (row) resolved.set(code, row);
    else missing.push(code);
  }
  return { resolved, missing };
}

/** Single-code convenience wrapper for GET-by-code style lookups. */
export async function resolveBoxByCode(db: DB, code: string): Promise<BoxRow | undefined> {
  const { resolved } = await resolveBoxesByCodes(db, [code]);
  return resolved.get(code);
}

export interface AssociateInput {
  tag: string;
  /** The single identifier the reader reports during a normal inventory —
   *  see `boxes.rfid` in db/schema.ts for why it is exactly one value. */
  rfid: string;
  replace: boolean;
  actor: string;
}

/**
 * Attaches (or, with `replace: true`, re-attaches after a damaged tag swap)
 * an RFID tag to a box. Two exception cases this deliberately guards:
 *
 * 1. **Reused tag** — the identifier is already on *another* box, which is
 *    either a mis-scan or someone peeling a tag off one box and sticking it
 *    on another without going through this endpoint. Always rejected (409),
 *    `replace` doesn't override this one — replace is for putting a *new,
 *    clean* tag on this box, not stealing another box's tag.
 * 2. **Already tagged** — a box that already carries a different tag needs
 *    `replace: true` to overwrite, so a second accidental scan of the wrong
 *    box doesn't silently detach its real tag.
 */
export async function associateTag(db: DB, input: AssociateInput) {
  const { tag, rfid, replace, actor } = input;

  return db.transaction(async (tx) => {
    const [box] = await tx.select().from(boxes).where(eq(boxes.tag, tag));
    if (!box) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');

    // Checked against the legacy columns too, so a tag registered under the
    // old two-column scheme can't be handed to a second box just because the
    // new column hasn't been written for it yet.
    const [claimedBy] = await tx
      .select()
      .from(boxes)
      .where(
        and(
          or(eq(boxes.rfid, rfid), eq(boxes.rfidTid, rfid), eq(boxes.rfidEpc, rfid)),
          ne(boxes.tag, tag),
        ),
      );
    if (claimedBy) {
      throw httpError(
        409,
        `แท็กนี้ผูกกับกล่อง ${claimedBy.tag} อยู่แล้ว — แท็กเดิมต้องถอดออกจากกล่องนั้นก่อน`,
        'rfid_tid_in_use',
      );
    }

    const current = box.rfid ?? box.rfidTid ?? box.rfidEpc;
    if (current && current !== rfid && !replace) {
      throw httpError(
        409,
        `กล่อง ${tag} มีแท็ก RFID ผูกอยู่แล้ว (${current}) — ส่ง replace: true เพื่อเปลี่ยนแท็ก`,
        'already_tagged',
      );
    }

    const before = { rfid: current ?? null };
    // `data` is the JSONB snapshot the legacy UI actually reads (via the
    // /api/state bridge) — the typed columns alone are invisible to it, per
    // the hybrid relational+JSONB design in db/schema.ts. The old keys are
    // cleared alongside so a replaced tag can't keep resolving by its
    // previous identifier.
    const data = { ...(box.data as Record<string, unknown>), rfid, rfidTid: null, rfidEpc: null };
    await tx
      .update(boxes)
      .set({ rfid, rfidTid: null, rfidEpc: null, data, updatedAt: new Date() })
      .where(eq(boxes.tag, tag));

    const after = { rfid };
    await writeAuditLog(tx, {
      action: current ? 'rfid_replace' : 'rfid_associate',
      actor,
      itemId: tag,
      itemName: tag,
      before,
      after,
    });

    return { tag, rfid };
  });
}

/** Detaches whatever tag a box carries — e.g. before scrapping the box, or
 *  before its tag gets manually reused elsewhere outside this API. */
export async function detachTag(db: DB, tag: string, actor: string) {
  return db.transaction(async (tx) => {
    const [box] = await tx.select().from(boxes).where(eq(boxes.tag, tag));
    if (!box) throw httpError(404, 'ไม่พบกล่อง', 'box_not_found');
    const current = box.rfid ?? box.rfidTid ?? box.rfidEpc;
    if (!current) throw httpError(409, `กล่อง ${tag} ไม่มีแท็ก RFID ผูกอยู่`, 'not_tagged');

    const before = { rfid: current };
    const data = { ...(box.data as Record<string, unknown>), rfid: null, rfidTid: null, rfidEpc: null };
    await tx
      .update(boxes)
      .set({ rfid: null, rfidTid: null, rfidEpc: null, data, updatedAt: new Date() })
      .where(eq(boxes.tag, tag));

    const after = { rfid: null };
    await writeAuditLog(tx, { action: 'rfid_detach', actor, itemId: tag, itemName: tag, before, after });

    return { tag };
  });
}
