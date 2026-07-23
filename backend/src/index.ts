import { createApp } from './app.js';
import { env } from './env.js';
import { applySchema, getDb, closeDb } from './db/client.js';
import { config, sequences } from './db/schema.js';

async function main() {
  // Ensure schema + singletons exist before serving (safe/idempotent).
  await applySchema();
  const db = getDb();
  await db.insert(config).values({ id: 1 }).onConflictDoNothing({ target: config.id });
  await db
    .insert(sequences)
    .values([{ name: 'do', value: 0 }, { name: 'emp', value: 0 }])
    .onConflictDoNothing({ target: sequences.name });

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[boxtrace-api] listening on http://localhost:${env.port}`);
    console.log(`[boxtrace-api] driver: ${env.usePglite ? 'PGlite (in-process)' : 'PostgreSQL'}`);
  });

  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[boxtrace-api] fatal:', err);
  process.exit(1);
});
