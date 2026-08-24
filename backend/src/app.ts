import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './env.js';
import { notFound, errorHandler } from './middleware/error.js';
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
import { gatePrefsRouter } from './routes/gatePrefs.js';
import { uiPrefsRouter } from './routes/uiPrefs.js';
import { rolesRouter } from './routes/roles.js';
import { systemRouter } from './routes/system.js';
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
  /* The FX9600 webhook takes its body as raw bytes instead of going through
     express.json() below, for two reasons found the hard way debugging a
     live reader:
       1. Zebra's IoT Connector doesn't document (or let you configure) the
          Content-Type it sends tag data with, and express.json() silently
          leaves req.body empty for anything it doesn't recognise as JSON —
          which is indistinguishable, downstream, from "the reader sent a
          heartbeat with no tags in it". Parsing the bytes ourselves makes
          the route work regardless of what header the reader picked.
       2. It lets the route log exactly what arrived on the wire (see
          fx9600DebugLog in routes/rfid.ts), which is the only way to tell
          "reader never sends tag data" apart from "reader sends it and we
          fail to parse it" — the whole question when a reader connects
          fine but no boxes ever get received.
     Mounted before express.json() so it wins for this path; body-parser
     skips anything already parsed (it sets req._body), so json() below is
     a no-op here rather than a conflict. */
  // Keep raw parsing scoped to the physical-reader webhook. Management APIs
  // under /api/rfid/fx9600 still need normal JSON request parsing.
  app.use('/api/rfid/fx9600/:gate/webhook', express.raw({ type: '*/*', limit: '10mb' }));
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
  app.use('/api/state', stateRouter);
  app.use('/api/gate', gateRouter);
  app.use('/api/boxes', boxesRouter);
  app.use('/api/rfid', rfidRouter);
  app.use('/api/masters', mastersRouter);
  app.use('/api/employees', employeePinRouter);
  app.use('/api/cycle-counts', cycleCountsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/stream', streamRouter);
  app.use('/api/gate-prefs', gatePrefsRouter);
  app.use('/api/ui-prefs', uiPrefsRouter);
  app.use('/api/roles', rolesRouter);
  app.use('/api/system', systemRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
