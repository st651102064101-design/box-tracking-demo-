import { Router } from 'express';
import { getDb } from '../db/client.js';
import { touchReader, getReaderStatuses } from '../services/fx9600.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

export const fx9600Router = Router();

/**
 * `POST /api/fx9600/webhook` — the FX9600's own HTTP POST Notification.
 *
 * No `requireAuth`: the reader is firmware, it can't hold a JWT session.
 * `requireApiKey` (mounted in app.ts, same as every other operational route)
 * is the actual gate here — set `X-API-Key` in the reader's POST headers, or
 * leave `API_KEY` unset for a LAN-only deployment.
 *
 * Configure the reader's notification URL as
 * `.../api/fx9600/webhook?reader=<id>&gate=<gateNo>` — `reader` is whatever
 * stable name identifies that physical unit (its serial/hostname/label);
 * `gate` is optional and only used to tag the row for display. The reader
 * must be set to fire on every read cycle, including cycles with zero tags
 * ("Report No Read" / heartbeat-on-empty in its own config) — otherwise a
 * reader that simply isn't seeing any tags looks identical to one that's
 * powered off, and this endpoint has no way to tell the two apart.
 */
fx9600Router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const readerId = String(req.query.reader ?? req.body?.reader ?? req.body?.readerName ?? '').trim();
    if (!readerId) {
      return res.status(400).json({ error: 'missing_reader', message: 'ต้องระบุ reader id (?reader=)' });
    }
    const gateRaw = req.query.gate ?? req.body?.gate;
    const gateNo = gateRaw !== undefined && gateRaw !== null && gateRaw !== '' ? Number(gateRaw) : null;
    await touchReader(getDb(), readerId, Number.isFinite(gateNo) ? gateNo : null, req.body);
    res.json({ ok: true });
  }),
);

/** `GET /api/fx9600/status` — initial paint for the UI; live updates arrive
 *  over `/api/stream`'s `readers` event instead of polling this. */
fx9600Router.get(
  '/status',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ readers: await getReaderStatuses(getDb()) });
  }),
);

export default fx9600Router;
