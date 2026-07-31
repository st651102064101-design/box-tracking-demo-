import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (nodeEnv === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production — refusing to start with the dev fallback secret.');
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
  usePglite: String(process.env.USE_PGLITE ?? 'false').toLowerCase() === 'true',
  pgliteDir: process.env.PGLITE_DIR ?? './.pglite',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://boxtrace:boxtrace@localhost:5432/boxtrace',
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const;

export type Env = typeof env;
