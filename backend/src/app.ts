import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './env.js';
import { notFound, errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { stateRouter } from './routes/state.js';
import { gateRouter } from './routes/gate.js';
import { boxesRouter } from './routes/boxes.js';
import { mastersRouter } from './routes/masters.js';

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

/** Build the Express app (kept separate from listen() so Supertest can import it). */
export function createApp() {
  const app = express();

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
  app.use(express.json({ limit: '25mb' })); // full-state snapshots can be large
  if (env.nodeEnv !== 'test') app.use(morgan('dev'));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'boxtrace-api', ts: new Date().toISOString() }));

  app.use('/api/auth', authRouter);
  app.use('/api/state', stateRouter);
  app.use('/api/gate', gateRouter);
  app.use('/api/boxes', boxesRouter);
  app.use('/api/masters', mastersRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
