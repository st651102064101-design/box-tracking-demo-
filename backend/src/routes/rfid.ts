import { Router, type Request, type Response, type NextFunction } from 'express';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { EPC_BITS, EpcEncodeError, encodeBarcodeToEpcHex, decodeEpcHexToBarcode, type EpcBits } from '../lib/rfid.js';
import { env } from '../env.js';
import { getDb } from '../db/client.js';
import { gateIn } from '../services/gate.js';
import { bump } from '../lib/bus.js';
import { gateWebhookStatus } from '../db/schema.js';

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
  return null;
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
  rawBody: unknown;
  epcs: string[];
  decoded: string[];
  received: string[];
  unknown: string[];
};
const fx9600DebugLog: Fx9600DebugEntry[] = [];
function pushFx9600DebugEntry(entry: Fx9600DebugEntry) {
  fx9600DebugLog.unshift(entry);
  if (fx9600DebugLog.length > FX9600_DEBUG_LOG_MAX) fx9600DebugLog.length = FX9600_DEBUG_LOG_MAX;
}

rfidRouter.get(
  '/fx9600/debug-log',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ entries: fx9600DebugLog });
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
    const db = getDb();
    await db
      .insert(gateWebhookStatus)
      .values({ gateNo: gate, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: gateWebhookStatus.gateNo, set: { lastSeenAt: new Date() } });

    const reads = extractReads(req.body);
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
        rawBody: req.body,
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
        return decoded || epcHex;
      } catch {
        return epcHex;
      }
    });

    const result = await gateIn(db, {
      tags,
      gate,
      recorder: `FX9600 · Gate ${gate}`,
      device: 'fx9600-webhook',
    });
    // Diagnostic visibility for whoever's debugging a reader in the field —
    // "connected but nothing happens" is otherwise a black box: this shows
    // exactly which EPCs came in, what they decoded to, and whether gateIn()
    // matched a real box. Only logs when there's actual tag data (skips the
    // frequent no-op heartbeats) to keep this from flooding the log.
    console.log(
      `[fx9600] gate ${gate}: epc=[${epcs.join(', ')}] decoded=[${tags.join(', ')}] received=[${result.received.join(', ')}] unknown=[${result.unknown.join(', ')}]`,
    );
    pushFx9600DebugEntry({
      ts: new Date().toISOString(),
      gate,
      rawBody: req.body,
      epcs,
      decoded: tags,
      received: result.received,
      unknown: result.unknown,
    });
    // Same reason the handheld routes call this — a reader-driven receive
    // never goes through PUT /api/state, so the dashboards would otherwise
    // sit stale until someone happens to refresh.
    bump();
    res.json(result);
  }),
);

export default rfidRouter;
