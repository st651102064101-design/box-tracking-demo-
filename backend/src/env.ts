import 'dotenv/config';
import { weakSecretReason } from './lib/secrets.js';

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (nodeEnv === 'production') {
  const required = [['JWT_SECRET', 32], ['FX9600_WEBHOOK_SECRET', 16], ['LPR_WEBHOOK_SECRET', 16]] as const;
  const problems = required
    .map(([name, min]) => [name, weakSecretReason(process.env[name], min)] as const)
    .filter(([, reason]) => reason)
    .map(([name, reason]) => `${name} ${reason}`);
  if (problems.length) {
    throw new Error(`Refusing to start in production: ${problems.join('; ')}. Run scripts/setup-env.sh (see .env.example).`);
  }
}

/** Centralised, typed access to environment configuration. */
export const env = {
  port: Number(process.env.PORT ?? 4000),
  /** Firebase project used for email-link password reset. Public id, not a secret. */
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? 'smarttrace-login',
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
  // Kept short since there's no refresh-token flow yet — a stolen token self-expires quickly.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
  // Second, independent factor on top of the JWT — a stolen/leaked bearer
  // token alone still isn't enough to call the API if this is set, since
  // every request also has to carry X-API-Key. Empty (the default) means
  // "not enforced", so an existing deployment/the legacy.html web client
  // (which has no way to be given this key today) keeps working unchanged
  // until an operator opts in by setting API_KEY — see requireApiKey.
  apiKey: process.env.API_KEY ?? '',
  seedAdmin: {
    username: process.env.SEED_ADMIN_USERNAME ?? 'admin',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123',
    name: process.env.SEED_ADMIN_NAME ?? 'ผู้ดูแลระบบ',
  },
  // Shared secret the Zebra FX9600's IoT Connector HTTP destination profile
  // sends back on every tag-read webhook POST (see routes/rfid.ts's
  // fx9600Webhook) — the fixed reader has no operator logged in to hold a
  // JWT, so this is the entire auth story for that one endpoint. Same
  // production guard as JWT_SECRET: refuse to boot on the dev default once
  // this is actually reachable from outside a laptop.
  fx9600WebhookSecret: process.env.FX9600_WEBHOOK_SECRET ?? 'dev-insecure-fx9600-secret-change-me',
  // Shared secret configured in the LPR camera's HTTP notification profile.
  // Physical cameras cannot carry an operator JWT, so their webhook uses a
  // dedicated header and secret instead of the browser authentication flow.
  lprWebhookSecret: process.env.LPR_WEBHOOK_SECRET ?? 'dev-insecure-lpr-secret-change-me',
  // Docker's bridge can make `req.ip` look like 172.18.0.1 instead of the
  // FX9600. Keep the browser-facing reader administration address explicit.
  fx9600AdminUrl: (process.env.FX9600_ADMIN_URL ?? '').trim(),
  usePglite: String(process.env.USE_PGLITE ?? 'false').toLowerCase() === 'true',
  pgliteDir: process.env.PGLITE_DIR ?? './.pglite',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://boxtrace:boxtrace@localhost:5432/boxtrace',
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const;

export type Env = typeof env;
