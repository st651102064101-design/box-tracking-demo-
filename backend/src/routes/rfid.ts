import { Router, type Request, type Response, type NextFunction } from 'express';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { EPC_BITS, EpcEncodeError, encodeBarcodeToEpcHex, decodeEpcHexToBarcode, type EpcBits } from '../lib/rfid.js';
import { env } from '../env.js';
import { getDb } from '../db/client.js';
import { resolveBoxesByCodes } from '../services/rfid.js';
import { gateWebhookStatus, gatePendingReads, gates, rfidAntennaGateMappings, rfidReaders } from '../db/schema.js';
import { and, eq, gte } from 'drizzle-orm';
import { writeAuditLog } from '../services/audit.js';
import { publishReaderStatus, publishRfidRead } from '../lib/bus.js';

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
function repeatKey(gate: number, tag: string) { return `${gate}:${tag}`; }
function splitRepeats(gate: number, tags: string[]): { fresh: string[]; repeats: string[] } {
  const now = Date.now();
  for (const [tag, ts] of fx9600RecentlySeen) {
    if (now - ts > FX9600_REPEAT_SUPPRESS_MS) fx9600RecentlySeen.delete(tag);
  }
  const fresh: string[] = [];
  const repeats: string[] = [];
  for (const tag of tags) {
    const last = fx9600RecentlySeen.get(repeatKey(gate, tag));
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

function extractAntenna(read: unknown): number | null {
  if (!read || typeof read !== 'object') return null;
  const obj = read as Record<string, unknown>;
  if (obj.data && typeof obj.data === 'object') return extractAntenna(obj.data);
  const raw = obj.antennaPort ?? obj.antenna_port ?? obj.antenna ?? obj.antennaId ?? obj.antennaID ?? obj.port;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= 32 ? value : null;
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

const readerView = (
  row: typeof rfidReaders.$inferSelect,
  status?: typeof gateWebhookStatus.$inferSelect,
  antennaMappings: Array<{ antennaPort: number; gateNo: number }> = [],
) => {
  const lastSeenAt = status?.lastSeenAt ?? null;
  const heartbeatIntervalSeconds = row.heartbeatIntervalSeconds;
  const staleMs = Math.max(5, heartbeatIntervalSeconds * 3) * 1000;
  const online = !!lastSeenAt && Date.now() - lastSeenAt.getTime() < staleMs;
  const scanning = online && !!status?.lastTagSeenAt && Date.now() - status.lastTagSeenAt.getTime() < 15_000;
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    gateNo: row.gateNo,
    webhookUrl: row.webhookUrl,
    transmitPower: Number(row.transmitPower),
    antennaCount: row.antennaCount,
    heartbeatIntervalSeconds,
    readingEnabled: row.readingEnabled,
    online,
    powerState: online ? 'on' : 'unknown',
    operationalState: !row.readingEnabled ? 'idle' : scanning ? 'scanning' : online ? 'idle' : 'error',
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
    lastTagSeenAt: status?.lastTagSeenAt?.toISOString() ?? null,
    activeAntennas: Array.isArray(status?.lastAntennas) ? status.lastAntennas : [],
    adminUrl: `https://${row.host}`,
    commandCapability: 'backend-ingest',
    antennaGateMappings: antennaMappings,
  };
};

rfidRouter.get(
  '/fx9600/readers',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const [readers, statuses, mappings] = await Promise.all([
      db.select().from(rfidReaders),
      db.select().from(gateWebhookStatus),
      db.select().from(rfidAntennaGateMappings),
    ]);
    const statusByGate = new Map(statuses.map((s) => [s.gateNo, s]));
    res.json({ readers: readers.map((r) => readerView(r, statusByGate.get(r.gateNo), mappings.filter((m) => m.readerId === r.id).map((m) => ({ antennaPort: m.antennaPort, gateNo: m.gateNo })))) });
  }),
);

function parseReaderInput(body: unknown) {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const name = String(src.name ?? '').trim();
  const host = String(src.host ?? '').trim();
  const gateNo = Number(src.gateNo);
  const webhookUrl = String(src.webhookUrl ?? '').trim();
  const transmitPower = Number(src.transmitPower);
  const antennaCount = Number(src.antennaCount);
  const heartbeatIntervalSeconds = Number(src.heartbeatIntervalSeconds ?? 1);
  if (!name || name.length > 100) throw httpError(400, 'ชื่อเครื่องอ่านไม่ถูกต้อง', 'invalid_reader_name');
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|(?:\d{1,3}\.){3}\d{1,3})$/i.test(host)) {
    throw httpError(400, 'Host/IP ของเครื่องอ่านไม่ถูกต้อง', 'invalid_reader_host');
  }
  if (!Number.isInteger(gateNo) || gateNo <= 0) throw httpError(400, 'Gate ไม่ถูกต้อง', 'invalid_gate');
  try {
    const parsed = new URL(webhookUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch {
    throw httpError(400, 'Webhook URL ต้องเป็น HTTP/HTTPS และห้ามฝังรหัสผ่าน', 'invalid_webhook_url');
  }
  if (!Number.isFinite(transmitPower) || transmitPower < 0 || transmitPower > 3) {
    throw httpError(400, 'Transmit Power ต้องอยู่ระหว่าง 0.00 ถึง 3.00', 'invalid_transmit_power');
  }
  if (!Number.isInteger(antennaCount) || antennaCount < 1 || antennaCount > 8) {
    throw httpError(400, 'จำนวนเสาอากาศต้องอยู่ระหว่าง 1 ถึง 8', 'invalid_antenna_count');
  }
  if (!Number.isInteger(heartbeatIntervalSeconds) || heartbeatIntervalSeconds < 1 || heartbeatIntervalSeconds > 60) {
    throw httpError(400, 'Heartbeat interval ต้องอยู่ระหว่าง 1 ถึง 60 วินาที', 'invalid_heartbeat_interval');
  }
  return { name, host, gateNo, webhookUrl, transmitPower: transmitPower.toFixed(2), antennaCount, heartbeatIntervalSeconds };
}

rfidRouter.put(
  '/fx9600/readers/:id',
  requireAuth,
  requirePermission('master.manage'),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id).trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,49}$/i.test(id)) throw httpError(400, 'Reader ID ไม่ถูกต้อง', 'invalid_reader_id');
    const data = parseReaderInput(req.body);
    const db = getDb();
    const before = (await db.select().from(rfidReaders).where(eq(rfidReaders.id, id)).limit(1))[0] ?? null;
    /* gate_no is unique in the database.  Check it explicitly before the
       upsert so the operator gets an actionable WMS message instead of a
       PostgreSQL constraint error when attempting to bind two readers to the
       same physical gate. */
    const gateOwner = (await db.select().from(rfidReaders).where(eq(rfidReaders.gateNo, data.gateNo)).limit(1))[0] ?? null;
    if (gateOwner && gateOwner.id !== id) {
      throw httpError(409, `Gate ${data.gateNo} ผูกกับเครื่องอ่าน ${gateOwner.name} อยู่แล้ว`, 'gate_reader_already_bound');
    }
    const [row] = await db
      .insert(rfidReaders)
      .values({ id, ...data, updatedAt: new Date(), updatedBy: req.user?.name })
      .onConflictDoUpdate({ target: rfidReaders.id, set: { ...data, updatedAt: new Date(), updatedBy: req.user?.name } })
      .returning();
    await writeAuditLog(db, { action: before ? 'reader_update' : 'reader_create', actor: req.user?.name ?? 'system', itemId: id, itemName: row.name, before, after: row });
    const status = (await db.select().from(gateWebhookStatus).where(eq(gateWebhookStatus.gateNo, row.gateNo)).limit(1))[0];
    res.json(readerView(row, status));
  }),
);

/**
 * Removes only the WMS-to-gate binding.  This never sends a command to the
 * FX9600: its network / IoT Connector configuration remains untouched, which
 * is important when a reader is being reassigned or serviced on site.
 */
rfidRouter.delete(
  '/fx9600/readers/:id',
  requireAuth,
  requirePermission('master.manage'),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id).trim();
    const db = getDb();
    const before = (await db.select().from(rfidReaders).where(eq(rfidReaders.id, id)).limit(1))[0] ?? null;
    if (!before) throw httpError(404, 'ไม่พบเครื่องอ่าน', 'reader_not_found');
    await db.delete(rfidReaders).where(eq(rfidReaders.id, id));
    await writeAuditLog(db, {
      action: 'reader_unbind',
      actor: req.user?.name ?? 'system',
      itemId: before.id,
      itemName: before.name,
      before,
      after: { unbound: true, gateNo: before.gateNo },
    });
    res.json({ ok: true, id: before.id, gateNo: before.gateNo });
  }),
);

rfidRouter.post(
  '/fx9600/readers/:id/reading',
  requireAuth,
  requirePermission('master.manage'),
  asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw httpError(400, 'enabled ต้องเป็น boolean', 'invalid_enabled');
    const db = getDb();
    const before = (await db.select().from(rfidReaders).where(eq(rfidReaders.id, req.params.id)).limit(1))[0];
    if (!before) throw httpError(404, 'ไม่พบเครื่องอ่าน', 'reader_not_found');
    const [row] = await db.update(rfidReaders).set({ readingEnabled: req.body.enabled, updatedAt: new Date(), updatedBy: req.user?.name }).where(eq(rfidReaders.id, req.params.id)).returning();
    await writeAuditLog(db, { action: req.body.enabled ? 'reader_start' : 'reader_stop', actor: req.user?.name ?? 'system', itemId: row.id, itemName: row.name, before: { readingEnabled: before.readingEnabled }, after: { readingEnabled: row.readingEnabled } });
    const status = (await db.select().from(gateWebhookStatus).where(eq(gateWebhookStatus.gateNo, row.gateNo)).limit(1))[0];
    res.json(readerView(row, status));
  }),
);

rfidRouter.put(
  '/fx9600/readers/:id/antenna-mappings',
  requireAuth,
  requirePermission('master.manage'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const reader = (await db.select().from(rfidReaders).where(eq(rfidReaders.id, req.params.id)).limit(1))[0];
    if (!reader) throw httpError(404, 'ไม่พบเครื่องอ่าน', 'reader_not_found');
    const raw = Array.isArray(req.body?.mappings) ? req.body.mappings as unknown[] : null;
    if (!raw) throw httpError(400, 'mappings ต้องเป็น array', 'invalid_antenna_mappings');
    const mappings = raw.map((item) => {
      const src = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const antennaPort = Number(src.antennaPort);
      const gateNo = Number(src.gateNo);
      if (!Number.isInteger(antennaPort) || antennaPort < 1 || antennaPort > 32 || !Number.isInteger(gateNo) || gateNo <= 0) {
        throw httpError(400, 'Antenna ต้องอยู่ระหว่าง 1-32 และ Gate ต้องเป็นเลขจำนวนเต็มบวก', 'invalid_antenna_mapping');
      }
      return { antennaPort, gateNo };
    });
    if (new Set(mappings.map((m) => m.antennaPort)).size !== mappings.length) {
      throw httpError(400, 'ห้ามกำหนด Antenna port ซ้ำ', 'duplicate_antenna_port');
    }
    if (mappings.length) {
      const knownGates = new Set((await db.select().from(gates)).map((g) => g.gateNo));
      const missingGate = mappings.find((m) => !knownGates.has(m.gateNo));
      if (missingGate) throw httpError(400, `ไม่พบ Gate ${missingGate.gateNo} ในคลัง`, 'gate_not_found');
    }
    const before = await db.select().from(rfidAntennaGateMappings).where(eq(rfidAntennaGateMappings.readerId, reader.id));
    await db.transaction(async (tx) => {
      await tx.delete(rfidAntennaGateMappings).where(eq(rfidAntennaGateMappings.readerId, reader.id));
      if (mappings.length) await tx.insert(rfidAntennaGateMappings).values(mappings.map((m) => ({ readerId: reader.id, ...m, updatedAt: new Date(), updatedBy: req.user?.name })));
    });
    await writeAuditLog(db, { action: 'reader_antenna_mapping_update', actor: req.user?.name ?? 'system', itemId: reader.id, itemName: reader.name, before, after: mappings });
    res.json({ readerId: reader.id, mappings });
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
    fx9600RecentlySeen.delete(repeatKey(gate, req.params.tag));
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
        fx9600RecentlySeen.delete(repeatKey(gate, tag));
      }
    } else {
      await getDb().delete(gatePendingReads).where(eq(gatePendingReads.gateNo, gate));
      for (const key of fx9600RecentlySeen.keys()) if (key.startsWith(`${gate}:`)) fx9600RecentlySeen.delete(key);
    }
    res.json({ ok: true });
  }),
);

rfidRouter.post(
  '/fx9600/:gate/webhook',
  requireFx9600Secret,
  asyncHandler(async (req, res) => {
    const fallbackGate = Number(req.params.gate);
    if (!Number.isInteger(fallbackGate) || fallbackGate <= 0) {
      throw httpError(400, 'gate ต้องเป็นเลขจำนวนเต็มบวก', 'invalid_gate');
    }
    const rawIp = req.ip ?? req.socket.remoteAddress ?? null;
    const lastIp = rawIp ? rawIp.replace(/^::ffff:/, '') : null;
    const db = getDb();
    const lastActiveAt = new Date();
    const body = readWebhookBody(req);
    const contentType = req.get('Content-Type') ?? '';
    const reads = extractReads(body.parsed);
    const activeReader = (await db.select().from(rfidReaders).where(eq(rfidReaders.gateNo, fallbackGate)).limit(1))[0] ?? null;
    const configuredMappings = activeReader
      ? await db.select().from(rfidAntennaGateMappings).where(eq(rfidAntennaGateMappings.readerId, activeReader.id))
      : [];
    const gateByAntenna = new Map(configuredMappings.map((m) => [m.antennaPort, m.gateNo]));
    const routedReads = reads.map((read) => ({ read, epc: extractEpc(read), antenna: extractAntenna(read) }));
    const epcs = routedReads.map((r) => r.epc).filter((epc): epc is string => epc !== null);
    const statusGates = new Set<number>([fallbackGate, ...configuredMappings.map((m) => m.gateNo)]);
    for (const gate of statusGates) {
      await db.insert(gateWebhookStatus)
        .values({ gateNo: gate, lastSeenAt: lastActiveAt, lastIp })
        .onConflictDoUpdate({ target: gateWebhookStatus.gateNo, set: { lastSeenAt: lastActiveAt, lastIp } });
      publishReaderStatus({ readerId: activeReader?.id ?? null, host: activeReader?.host ?? null, sourceIp: lastIp, gate, lastActiveAt: lastActiveAt.toISOString() });
    }

    if (!epcs.length) {
      pushFx9600DebugEntry({
        ts: new Date().toISOString(),
        gate: fallbackGate,
        rawBody: body.text.slice(0, RAW_BODY_LOG_MAX),
        contentType,
        parseError: body.parseError,
        epcs: [],
        decoded: [],
        received: [],
        unknown: [],
      });
      res.json({ ok: true, received: [], unknown: [], count: 0, routed: {} });
      return;
    }
    if (activeReader && !activeReader.readingEnabled) {
      pushFx9600DebugEntry({
        ts: new Date().toISOString(), gate: fallbackGate, rawBody: body.text.slice(0, RAW_BODY_LOG_MAX),
        contentType, epcs, decoded: [], received: [], unknown: [],
      });
      res.json({ ok: true, paused: true, received: [], unknown: [], count: 0 });
      return;
    }

    const decodeTag = (epcHex: string) => {
      try {
        const decoded = decodeEpcHexToBarcode(epcHex);
        return decoded && /^[\x20-\x7E]+$/.test(decoded) ? decoded : epcHex;
      } catch {
        return epcHex;
      }
    };

    const readsByGate = new Map<number, Array<{ epc: string; antenna: number | null }>>();
    for (const item of routedReads) {
      if (!item.epc) continue;
      const targetGate = item.antenna !== null ? (gateByAntenna.get(item.antenna) ?? fallbackGate) : fallbackGate;
      const group = readsByGate.get(targetGate) ?? [];
      group.push({ epc: item.epc, antenna: item.antenna });
      readsByGate.set(targetGate, group);
    }

    const allReceived: string[] = [];
    const allUnknown: string[] = [];
    const routed: Record<string, { received: string[]; unknown: string[]; antennas: number[] }> = {};
    for (const [gate, group] of readsByGate) {
      const antennas = Array.from(new Set(group.map((r) => r.antenna).filter((a): a is number => a !== null))).sort((a, b) => a - b);
      await db.update(gateWebhookStatus).set({ lastTagSeenAt: lastActiveAt, lastAntennas: antennas }).where(eq(gateWebhookStatus.gateNo, gate));
      const tags = group.map((r) => decodeTag(r.epc));
      const { resolved, missing } = await resolveBoxesByCodes(db, Array.from(new Set(tags)));
      const boxTags = Array.from(new Set(Array.from(resolved.values()).map((row) => row.tag)));
      const { fresh, repeats } = splitRepeats(gate, boxTags);
      const now = Date.now();
      for (const tag of fresh) fx9600RecentlySeen.set(repeatKey(gate, tag), now);
      if (boxTags.length) {
        await db.insert(gatePendingReads)
          .values(boxTags.map((tag) => ({ gateNo: gate, tag, seenAt: lastActiveAt })))
          .onConflictDoUpdate({ target: [gatePendingReads.gateNo, gatePendingReads.tag], set: { seenAt: lastActiveAt } });
      }
      routed[String(gate)] = { received: fresh, unknown: missing, antennas };
      allReceived.push(...fresh);
      allUnknown.push(...missing);
      console.log(`[fx9600] reader=${activeReader?.id ?? 'unbound'} gate=${gate} antenna=[${antennas.join(',')}] decoded=[${tags.join(', ')}] received=[${fresh.join(', ')}] unknown=[${missing.join(', ')}] repeat=${repeats.length}`);
      pushFx9600DebugEntry({ ts: new Date().toISOString(), gate, rawBody: body.text.slice(0, RAW_BODY_LOG_MAX), contentType, parseError: body.parseError, epcs: group.map((r) => r.epc), decoded: tags, received: fresh, unknown: missing, repeats });
      if (fresh.length) publishRfidRead(gate, fresh);
    }
    res.json({ ok: true, received: Array.from(new Set(allReceived)), unknown: Array.from(new Set(allUnknown)), count: allReceived.length, routed });
  }),
);

export default rfidRouter;
