import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (nodeEnv === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production — refusing to start with the dev fallback secret.');
}
if (nodeEnv === 'production' && !process.env.FX9600_WEBHOOK_SECRET) {
  throw new Error(
    'FX9600_WEBHOOK_SECRET must be set in production — refusing to start with the dev fallback secret.',
  );
}

/** Centralised, typed access to environment configuration. */
export const env = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
  // Kept short since there's no refresh-token flow yet — a stolen token self-expires quickly.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
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
  usePglite: String(process.env.USE_PGLITE ?? 'false').toLowerCase() === 'true',
  pgliteDir: process.env.PGLITE_DIR ?? './.pglite',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://boxtrace:boxtrace@localhost:5432/boxtrace',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  // Used to email PDA PIN-reset codes straight to an employee's own inbox
  // (see routes/pin.ts). Unset in dev by default — sendMail() throws a clear
  // "not configured" error rather than silently dropping the email, so a
  // missing setup fails loud instead of leaving an employee locked out with
  // no explanation.
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: String(process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
  },
} as const;

export type Env = typeof env;
