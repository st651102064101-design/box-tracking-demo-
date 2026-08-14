import { Router, type Request, type Response, type NextFunction } from 'express';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { EPC_BITS, EpcEncodeError, encodeBarcodeToEpcHex, decodeEpcHexToBarcode, type EpcBits } from '../lib/rfid.js';
import { env } from '../env.js';
import { getDb } from '../db/client.js';
import { resolveBoxesByCodes } from '../services/rfid.js';
import { gateWebhookStatus, gatePendingReads } from '../db/schema.js';
import { and, eq, gte } from 'drizzle-orm';

export const rfidRouter = Router();

/**
 * Preview-only: computes the hex a PDA should Write to a blank tag's EPC
 * bank for this barcode. Doesn't touch the database — the box only actually
 * gets tagged once the PDA reads the write back and calls
 * POST /api/boxes/:tag/rfid with what's really on the chip (see boxes.ts).
 */
rfidRouter.get(
  '/encode/:tag',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bits = req.query.bits === '128' ? EPC_BITS.EPC_128 : (EPC_BITS.EPC_96 as EpcBits);
    try {
      const epcHex = encodeBarcodeToEpcHex(req.params.tag, bits);
      res.json({ tag: req.params.tag, bits, epcHex });
    } catch (e) {
      if (e instanceof EpcEncodeError) throw httpError(400, e.message, 'epc_encode_error');
      throw e;
    }
  }),
);

/**
 * Tag-read webhook for a fixed Zebra FX9600 reader running the IoT
 * Connector app in "HTTP POST" mode, one destination profile per gate
 * (the gate number lives in the URL, configured once when the profile is
 * set up — a fixed reader never moves, so there's nothing to pick per
 * request the way a handheld's own login does that job instead).
 *
 * No JWT here — the reader has no operator signed into it to hold one.
 * requireFx9600Secret is the entire auth story: a shared secret configured
 * both here (FX9600_WEBHOOK_SECRET) and in the IoT Connector profile.
 * Accepted two ways because the FX9600's own "HTTP POST" endpoint config
 * screen (Zebra IoT Connector) only offers None / Basic Authentication / TLS
 * for Authentication Type — there is no field for an arbitrary custom
 * header, so X-Webhook-Secret (still supported, e.g. for curl/testing or a
 * future reader firmware that does support it) isn't reachable from that
 * UI at all. HTTP Basic is: any username, password = the secret.
 *
 * IoT Connector's HTTP POST payload shape is configurable per profile
 * (the "REST" template), so this accepts the field names Zebra's stock
 * templates commonly use, in a few common shapes:
 *   - a single object                      { idHex: "..." }
 *   - an object wrapping the read           { data: { idHex: "..." } }
 *   - an array of either of the above       [{ idHex: "..." }, ...]
 * If your reader's profile emits something else, adjust EPC_FIELD_CANDIDATES
 * below to match — the rest of the pipeline (decode -> gateIn) doesn't care.
 */
const EPC_FIELD_CANDIDATES = ['idHex', 'epc', 'EPC', 'tagId', 'id'] as const;

function extractEpc(read: unknown): string | null {
  if (!read || typeof read !== 'object') return null;
  const obj = read as Record<string, unknown>;
  for (const field of EPC_FIELD_CANDIDATES) {
    const v = obj[field];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  /* What a real FX9600 actually sends: an array whose every element wraps the
     read one level down, e.g.
       [{"data":{"antenna":1,"format":"epc","idHex":"...","peakRssi":-72},
         "timestamp":"...","type":"INVENTORY"}, ...]
     Only the single-object {data:{...}} form was unwrapped before, so the
     array-of-wrapped-events case (the one the reader uses) found nothing at
     the top level and every report was silently treated as a tagless
     heartbeat — the reason a correctly-configured reader appeared to send
     data that never matched a box. */
  if (obj.data && typeof obj.data === 'object') return extractEpc(obj.data);
  return null;
}

/* A fixed reader re-reports a tag for as long as it stays in the antenna's
   field — INVENTORY mode does so every second by design. gateIn() appends a
   history entry (and audit row) per call, so without suppression a box parked
   near the gate would accumulate one every second indefinitely. Kept in memory
   rather than a table because the only thing at stake is duplicate noise: the
   worst case after a restart is one extra receive, which is harmless and
   self-correcting. */
const FX9600_REPEAT_SUPPRESS_MS = 60_000;
const fx9600RecentlySeen = new Map<string, number>();
function splitRepeats(tags: string[]): { fresh: string[]; repeats: string[] } {
  const now = Date.now();
  for (const [tag, ts] of fx9600RecentlySeen) {
    if (now - ts > FX9600_REPEAT_SUPPRESS_MS) fx9600RecentlySeen.delete(tag);
  }
  const fresh: string[] = [];
  const repeats: string[] = [];
  for (const tag of tags) {
    const last = fx9600RecentlySeen.get(tag);
    if (last !== undefined && now - last < FX9600_REPEAT_SUPPRESS_MS) repeats.push(tag);
    else fresh.push(tag);
  }
  return { fresh, repeats };
}

function extractReads(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (obj.data && typeof obj.data === 'object') return [obj.data];
    if (Array.isArray(obj.tagReports)) return obj.tagReports;
    return [obj];
  }
  return [];
}

/** Decodes `Authorization: Basic base64(user:pass)`, returning just the
 *  password half — the username is whatever the IoT Connector profile was
 *  given and isn't checked against anything. */
function basicAuthPassword(req: Request): string | null {
  const header = req.get('Authorization') ?? '';
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    return sep === -1 ? decoded : decoded.slice(sep + 1);
  } catch {
    return null;
  }
}

function requireFx9600Secret(req: Request, res: Response, next: NextFunction) {
  const headerSecret = req.get('X-Webhook-Secret') ?? '';
  const basicSecret = basicAuthPassword(req) ?? '';
  if (headerSecret !== env.fx9600WebhookSecret && basicSecret !== env.fx9600WebhookSecret) {
    res.status(401).json({ error: 'unauthorized', message: 'invalid webhook secret' });
    return;
  }
  next();
}

/**
 * Raw request log for on-site FX9600 debugging (see GET /fx9600/debug-log
 * below) — an in-memory ring buffer, not persisted. This is purely a "what
 * is the reader actually sending, right now" window for whoever's stood
 * next to the physical reader with a laptop; it doesn't need to survive a
 * backend restart or be queryable historically the way real data does.
 * Every request that passes the secret check is recorded here, heartbeats
 * included, so "nothing in the log" is itself a meaningful diagnostic
 * signal (webhook unreachable) distinct from "log has entries but no EPCs"
 * (reader connected but not sending tag data — the actual bug hunted here).
 */
const FX9600_DEBUG_LOG_MAX = 200;
type Fx9600DebugEntry = {
  ts: string;
  gate: number;
  /** Exactly what arrived on the wire, before any parsing — the whole point
   *  of the raw-body mount in app.ts. Truncated so one oversized report
   *  can't push the rest of the ring buffer out of memory. */
  rawBody: string;
  contentType: string;
  parseError?: string;
  epcs: string[];
  decoded: string[];
  received: string[];
  unknown: string[];
  /** Tags skipped because this route already received them within
   *  FX9600_REPEAT_SUPPRESS_MS — expected and healthy for a fixed reader
   *  staring at a stationary box, but worth showing so "nothing happened"
   *  is distinguishable from "nothing was sent". */
  repeats?: string[];
};
const fx9600DebugLog: Fx9600DebugEntry[] = [];
function pushFx9600DebugEntry(entry: Fx9600DebugEntry) {
  fx9600DebugLog.unshift(entry);
  if (fx9600DebugLog.length > FX9600_DEBUG_LOG_MAX) fx9600DebugLog.length = FX9600_DEBUG_LOG_MAX;
}

const RAW_BODY_LOG_MAX = 4000;

/**
 * The webhook's body arrives as raw bytes (see the express.raw mount in
 * app.ts) so this route can accept it whatever Content-Type the reader
 * chose, and log what actually came in. Returns the decoded text alongside
 * the parsed value so the caller can record both.
 */
function readWebhookBody(req: Request): { text: string; parsed: unknown; parseError?: string } {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const text = raw.toString('utf8');
  if (!text.trim()) return { text, parsed: {} };
  try {
    return { text, parsed: JSON.parse(text) };
  } catch (e) {
    return { text, parsed: {}, parseError: e instanceof Error ? e.message : String(e) };
  }
}

rfidRouter.get(
  '/fx9600/debug-log',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ entries: fx9600DebugLog });
  }),
);

/* ─── the reader's pending queue for Gate ขาเข้า ───────────────────────────
   Populated by the webhook below, drained by the operator confirming (or
   dismissing) chips in the UI. Reads older than this are ignored rather than
   deleted on a timer: a box that passed by ten minutes ago and was never
   confirmed shouldn't still be sitting in someone's queue, but nothing needs
   to run in the background to make that true. */
const PENDING_TTL_MS = 10 * 60 * 1000;

rfidRouter.get(
  '/pending/:gate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const gate = Number(req.params.gate);
    if (!Number.isInteger(gate) || gate <= 0) {
      throw httpError(400, 'gate ต้องเป็นเลขจำนวนเต็มบวก', 'invalid_gate');
    }
    const rows = await getDb()
      .select()
      .from(gatePendingReads)
      .where(
        and(
          eq(gatePendingReads.gateNo, gate),
          gte(gatePendingReads.seenAt, new Date(Date.now() - PENDING_TTL_MS)),
        ),
      );
    res.json({ tags: rows.map((r) => r.tag) });
  }),
);

/** Drops one box from the queue — the chip's ✕ button. Without this the
 *  reader would just re-queue it on its next report, since the box is still
 *  sitting in range. */
rfidRouter.delete(
  '/pending/:gate/:tag',
  requireAuth,
  asyncHandler(async (req, res) => {
    const gate = Number(req.params.gate);
    if (!Number.isInteger(gate) || gate <= 0) {
      throw httpError(400, 'gate ต้องเป็นเลขจำนวนเต็มบวก', 'invalid_gate');
    }
    await getDb()
      .delete(gatePendingReads)
      .where(and(eq(gatePendingReads.gateNo, gate), eq(gatePendingReads.tag, req.params.tag)));
    // Suppression is keyed on "already queued", so a tag the operator
    // deliberately removed must forget that too — otherwise it can't come
    // back until the window lapses, even if the box really is re-presented.
    fx9600RecentlySeen.delete(req.params.tag);
    res.json({ ok: true });
  }),
);

/** Clears the whole queue for a gate — used right after the operator confirms
 *  the receive, so the boxes they just booked in don't immediately reappear. */
rfidRouter.delete(
  '/pending/:gate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const gate = Number(req.params.gate);
    if (!Number.isInteger(gate) || gate <= 0) {
      throw httpError(400, 'gate ต้องเป็นเลขจำนวนเต็มบวก', 'invalid_gate');
    }
    const tags = Array.isArray(req.body?.tags) ? (req.body.tags as unknown[]).filter((t): t is string => typeof t === 'string') : null;
    if (tags && tags.length) {
      for (const tag of tags) {
        await getDb()
          .delete(gatePendingReads)
          .where(and(eq(gatePendingReads.gateNo, gate), eq(gatePendingReads.tag, tag)));
        fx9600RecentlySeen.delete(tag);
      }
    } else {
      await getDb().delete(gatePendingReads).where(eq(gatePendingReads.gateNo, gate));
      fx9600RecentlySeen.clear();
    }
    res.json({ ok: true });
  }),
);

rfidRouter.post(
  '/fx9600/:gate/webhook',
  requireFx9600Secret,
  asyncHandler(async (req, res) => {
    const gate = Number(req.params.gate);
    if (!Number.isInteger(gate) || gate <= 0) {
      throw httpError(400, 'gate ต้องเป็นเลขจำนวนเต็มบวก', 'invalid_gate');
    }

    // Marks this gate "connected" for the frontend's status light — updated on
    // every valid request (secret + gate both check out), tag reads or not,
    // since a heartbeat/empty payload still proves the reader is reachable
    // and correctly configured. Fire-and-forget relative to the actual
    // gate-in below: a status-table hiccup shouldn't block receiving boxes.
    //
    // Also records the reader's own source IP so the frontend can offer a
    // "manage this reader" button pointed at the FX9600's admin UI without
    // anyone hardcoding an address — the reader tells us where it's calling
    // from on every request. `req.ip` (not header-trusting; no reverse proxy
    // sits between the reader and this route) sometimes carries the
    // IPv4-mapped-IPv6 "::ffff:" prefix Node uses for dual-stack sockets —
    // stripped so the stored value is a plain IPv4 the admin UI link works with.
    const rawIp = req.ip ?? req.socket.remoteAddress ?? null;
    const lastIp = rawIp ? rawIp.replace(/^::ffff:/, '') : null;
    const db = getDb();
    await db
      .insert(gateWebhookStatus)
      .values({ gateNo: gate, lastSeenAt: new Date(), lastIp })
      .onConflictDoUpdate({ target: gateWebhookStatus.gateNo, set: { lastSeenAt: new Date(), lastIp } });

    const body = readWebhookBody(req);
    const contentType = req.get('Content-Type') ?? '';
    const reads = extractReads(body.parsed);
    const epcs = reads.map(extractEpc).filter((e): e is string => e !== null);
    if (!epcs.length) {
      // Not an error — IoT Connector can POST a heartbeat/status payload with
      // no tag data in it. Nothing to receive, nothing to fail on.
      // Same shape as gateIn()'s own response (received: string[]), not a
      // bare count — a caller checking .received.length or .includes(tag)
      // shouldn't need a special case for "nothing to receive".
      pushFx9600DebugEntry({
        ts: new Date().toISOString(),
        gate,
        rawBody: body.text.slice(0, RAW_BODY_LOG_MAX),
        contentType,
        parseError: body.parseError,
        epcs: [],
        decoded: [],
        received: [],
        unknown: [],
      });
      res.json({ ok: true, received: [], unknown: [], count: 0 });
      return;
    }

    // Every tag this system writes carries the box's own barcode as ASCII in
    // the EPC bank (see lib/rfid.ts's encodeBarcodeToEpcHex) — decode first
    // so resolveBoxesByCodes matches on box.tag even for a tag that was
    // physically written but never explicitly bound via POST
    // /api/boxes/:tag/rfid. A tag that doesn't decode to anything (foreign/
    // blank/binary) falls back to the raw EPC hex, which still matches a box
    // explicitly bound by rfid_epc.
    const tags = epcs.map((epcHex) => {
      try {
        const decoded = decodeEpcHexToBarcode(epcHex);
        /* A foreign tag's EPC is arbitrary bytes, and decoding those as ASCII
           can yield control characters — including NUL, which Postgres
           rejects outright ("invalid byte sequence for encoding UTF8: 0x00").
           Since a real reader reports every tag in range, one stranger's tag
           sharing a batch with our boxes would otherwise fail the whole
           report and receive nothing at all. Anything that isn't clean
           printable ASCII is treated as "not one of ours" and matched by raw
           hex instead (which still resolves a box explicitly bound by
           rfid_epc). */
        return decoded && /^[\x20-\x7E]+$/.test(decoded) ? decoded : epcHex;
      } catch {
        return epcHex;
      }
    });

    /* Queue for the operator instead of receiving outright. A fixed reader
       sees everything in range — boxes still on the truck, boxes carried past
       the door, boxes sitting on a nearby rack — so auto-receiving would book
       in things that never actually arrived. The reads land in
       gate_pending_reads, surface as chips in Gate ขาเข้า, and only become a
       real gate-in when someone presses ยืนยันรับเข้าคลัง (which goes through
       the same PUT /api/state path a manual barcode scan already used).
       Only codes that resolve to a real box are queued: a gate typically has
       a dozen foreign tags in range, and listing those as chips would bury
       the boxes that matter. */
    const unique = Array.from(new Set(tags));
    const { resolved, missing } = await resolveBoxesByCodes(db, unique);
    /* Boxes already sitting in the warehouse are skipped, matching what the
       operator gets from a manual barcode scan ("อยู่ในคลังอยู่แล้ว"). Without
       this, a reader whose field covers nearby racks would permanently fill
       the queue with stock that's already booked in and can't be received
       again. */
    const boxTags = Array.from(
      new Set(
        Array.from(resolved.values())
          .filter((r) => r.status !== 'warehouse')
          .map((r) => r.tag),
      ),
    );
    const { fresh, repeats } = splitRepeats(boxTags);
    const now = Date.now();
    for (const tag of fresh) fx9600RecentlySeen.set(tag, now);

    if (boxTags.length) {
      // seen_at refreshed even for repeats so a box sitting in range keeps the
      // queue entry alive rather than ageing out from under the operator.
      await db
        .insert(gatePendingReads)
        .values(boxTags.map((tag) => ({ gateNo: gate, tag, seenAt: new Date() })))
        .onConflictDoUpdate({
          target: [gatePendingReads.gateNo, gatePendingReads.tag],
          set: { seenAt: new Date() },
        });
    }
    const result = { ok: true as const, received: fresh, unknown: missing, count: fresh.length };
    // Diagnostic visibility for whoever's debugging a reader in the field —
    // "connected but nothing happens" is otherwise a black box: this shows
    // exactly which EPCs came in, what they decoded to, and whether gateIn()
    // matched a real box. Only logs when there's actual tag data (skips the
    // frequent no-op heartbeats) to keep this from flooding the log.
    console.log(
      `[fx9600] gate ${gate}: epc=${epcs.length} decoded=[${tags.join(', ')}] received=[${result.received.join(', ')}] unknown=[${result.unknown.join(', ')}] repeat=${repeats.length}`,
    );
    pushFx9600DebugEntry({
      ts: new Date().toISOString(),
      gate,
      rawBody: body.text.slice(0, RAW_BODY_LOG_MAX),
      contentType,
      epcs,
      decoded: tags,
      received: result.received,
      unknown: result.unknown,
      repeats,
    });
    /* Deliberately no bump() here any more. It made sense while this route
       received boxes directly (box state changed, so every browser needed to
       refetch), but queuing touches nothing in the /api/state snapshot — the
       queue has its own endpoint the Gate ขาเข้า screen polls. Waking every
       connected client to re-pull the full state once a second, per the
       reader's report interval, for data that didn't change would be pure
       waste. The receive itself still bumps, via the normal save() path. */
    res.json(result);
  }),
);

export default rfidRouter;
