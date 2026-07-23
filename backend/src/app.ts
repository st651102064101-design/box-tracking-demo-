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

/** Build the Express app (kept separate from listen() so Supertest can import it). */
export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigin.length ? env.corsOrigin : true,
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
