/**
 * Database client with a swappable driver:
 *   - `USE_PGLITE=true`  → @electric-sql/pglite (in-process WASM Postgres).
 *       Great for tests and zero-dependency local runs.
 *   - `USE_PGLITE=false` → node-postgres Pool against PostgreSQL 16.
 *
 * The Drizzle schema is identical for both drivers, so business code never
 * needs to know which one is active.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { env } from '../env.js';
import { schema } from './schema.js';

export type DB = NodePgDatabase<typeof schema>;

let _db: DB | null = null;
let _rawExec: ((sql: string) => Promise<void>) | null = null;
let _close: (() => Promise<void>) | null = null;
let _notificationClient: pg.Client | null = null;

function init() {
  if (_db) return;
  if (env.usePglite) {
    const client = new PGlite(env.pgliteDir === ':memory:' ? undefined : env.pgliteDir);
    _db = drizzlePglite(client, { schema }) as unknown as DB;
    _rawExec = async (sql: string) => {
      await client.exec(sql);
    };
    _close = async () => {
      await client.close();
    };
  } else {
    const pool = new pg.Pool({ connectionString: env.databaseUrl });
    _db = drizzlePg(pool, { schema });
    _rawExec = async (sql: string) => {
      await pool.query(sql);
    };
    _close = async () => {
      await pool.end();
    };
  }
}

export function getDb(): DB {
  init();
  return _db!;
}

/** Run raw (possibly multi-statement) SQL — used only for schema bootstrap. */
export async function rawExec(sql: string): Promise<void> {
  init();
  await _rawExec!(sql);
}

export async function closeDb(): Promise<void> {
  if (_notificationClient) {
    await _notificationClient.end();
    _notificationClient = null;
  }
  if (_close) await _close();
  _db = null;
  _rawExec = null;
  _close = null;
}

/**
 * Listen for commits made outside this API process.  The schema installs
 * `boxtrace_warehouse3d_changed` triggers on the tables that form the 3D
 * model.  PostgreSQL delivers NOTIFY only after commit, so browsers never
 * fetch a half-written warehouse layout.
 *
 * PGlite deliberately has no cross-process database to observe; its normal
 * in-process `bump()` calls remain the realtime path for unit tests/dev mode.
 */
export async function startWarehouse3dChangeListener(
  onChange: (scope: 'warehouse3d' | 'location-master') => void,
): Promise<() => Promise<void>> {
  if (env.usePglite) return async () => undefined;
  if (_notificationClient) return async () => undefined;

  const client = new pg.Client({ connectionString: env.databaseUrl });
  await client.connect();
  await client.query('LISTEN boxtrace_warehouse3d_changed');
  client.on('notification', (message) => {
    if (message.channel !== 'boxtrace_warehouse3d_changed') return;
    if (message.payload === 'warehouse3d' || message.payload === 'location-master') {
      onChange(message.payload);
    }
  });
  client.on('error', (error) => {
    // A listener failure must not take the API down.  The process supervisor
    // restarts it, while browsers retain their polling fallback in the interim.
    console.error('[db] warehouse 3D change listener failed', error.message);
  });
  _notificationClient = client;
  return async () => {
    if (_notificationClient !== client) return;
    _notificationClient = null;
    await client.end();
  };
}

/** Apply the canonical schema.sql (idempotent). Used by tests and `db:migrate`. */
export async function applySchema(): Promise<void> {
  const sqlPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
  const ddl = readFileSync(sqlPath, 'utf8');
  await rawExec(ddl);
}
