import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

/**
 * drizzle-kit config for generating/pushing migrations against real Postgres.
 * (Tests and quick local runs use PGlite + src/db/schema.sql instead.)
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://boxtrace:boxtrace@localhost:5432/boxtrace',
  },
  verbose: true,
  strict: true,
});
