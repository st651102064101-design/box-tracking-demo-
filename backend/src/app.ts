import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './env.js';
import { notFound, errorHandler } from './middleware/error.js';
import { requireApiKey } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { stateRouter } from './routes/state.js';
import { gateRouter } from './routes/gate.js';
import { boxesRouter } from './routes/boxes.js';
import { rfidRouter } from './routes/rfid.js';
import { mastersRouter } from './routes/masters.js';
import { employeePinRouter } from './routes/pin.js';
import { cycleCountsRouter } from './routes/cycle-counts.js';
import { reportsRouter } from './routes/reports.js';
import { streamRouter } from './routes/stream.js';
import { fx9600Router } from './routes/fx9600.js';
import { currentVersion, subscriberCount } from './lib/bus.js';

/**
 * Operators reach this API from tablets/scanners on the same warehouse LAN,
 * over whatever private IP their router/DHCP happens to hand out — CORS_ORIGIN
 * alone can't be kept in sync with that, so any private-network origin is
 * allowed on top of the explicit allowlist. This app is never meant to be
 * internet-exposed, and it's Bearer-token auth (not cookies), so a browser on
 * a public origin still can't do anything useful even though CORS lets it ask.
 */
const PRIVATE_LAN_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?::\d+)?$/;

/** Throttles credential-guessing against /login and self-registration spam
 *  against /register — both are public, unauthenticated endpoints. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
});

/**
 * Baseline throttle for every authenticated (operational) endpoint —
 * gate/boxes/masters/rfid/pin/state — previously unlimited entirely. 300
 * requests/min comfortably covers a real terminal (RFID batches, polling,
 * queue commits) while still bounding a runaway client or a credential
 * that's actively being abused. authLimiter above stays separate and
 * stricter since login/register are unauthenticated and a much cheaper
 * target to hammer.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'มีการเรียก API ถี่เกินไป กรุณาลองใหม่ภายหลัง' },
});

/** FX9600 readers heartbeat far more often than any human-driven endpoint —
 *  every read cycle, potentially every 1-2s, from potentially several units
 *  sharing one gateway IP. 600/min per IP covers that comfortably while
 *  still bounding a runaway/misconfigured device. */
const fx9600Limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'FX9600 ส่ง webhook ถี่เกินไป' },
});

/** Build the Express app (kept separate from listen() so Supertest can import it). */
export function createApp() {
  const app = express();

  // This is a JSON API + SSE stream, never an HTML page host, so helmet's
  // default (strict, self-only) CSP has nothing legitimate to break here.
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || env.corsOrigin.includes(origin) || PRIVATE_LAN_ORIGIN.test(origin)) {
          return cb(null, true);
        }
        cb(new Error(`Not allowed by CORS: ${origin}`));
      },
      credentials: true,
    }),
  );
  // Full-state snapshots can be large, but 25mb was needlessly generous for a
  // request body and widened the DoS surface; 10mb comfortably covers real
  // snapshots while capping worst-case memory per request.
  app.use(express.json({ limit: '10mb' }));
  /* The SSE URL carries the auth token as a query parameter, because
     EventSource cannot send headers. Access logs are the one place that
     must not end up written down, and one line per long-lived connection
     is worth little anyway. */
  if (env.nodeEnv !== 'test')
    app.use(morgan('dev', { skip: (req) => req.path.startsWith('/api/stream') }));

  /* `streams` and `version` make it possible to tell "nothing changed" apart
     from "the realtime pipe is down" without opening a browser. */
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      service: 'boxtrace-api',
      ts: new Date().toISOString(),
      version: currentVersion(),
      streams: subscriberCount(),
    }));

  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth', authRouter);
  // Every operational route beyond this point is authenticated (each
  // router's own requireAuth), rate-limited, and — once API_KEY is set —
  // also requires X-API-Key. /api/stream is excluded: it's a long-lived SSE
  // connection, not a request burst, so the per-minute request limiter
  // doesn't apply to it in any useful way, and it authenticates via its own
  // query-param token instead of a header (EventSource can't send headers).
  app.use('/api/state', apiLimiter, requireApiKey, stateRouter);
  app.use('/api/gate', apiLimiter, requireApiKey, gateRouter);
  app.use('/api/boxes', apiLimiter, requireApiKey, boxesRouter);
  app.use('/api/rfid', apiLimiter, requireApiKey, rfidRouter);
  app.use('/api/masters', apiLimiter, requireApiKey, mastersRouter);
  app.use('/api/employees', apiLimiter, requireApiKey, employeePinRouter);
  app.use('/api/cycle-counts', apiLimiter, requireApiKey, cycleCountsRouter);
  app.use('/api/reports', apiLimiter, requireApiKey, reportsRouter);
  app.use('/api/stream', streamRouter);
  // requireAuth on GET /status only (see routes/fx9600.ts); POST /webhook is
  // the reader itself, gated by requireApiKey instead of a JWT it can't hold.
  app.use('/api/fx9600', fx9600Limiter, requireApiKey, fx9600Router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
