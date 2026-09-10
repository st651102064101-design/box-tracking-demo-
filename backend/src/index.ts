import { createApp } from './app.js';
import { env } from './env.js';
import { applySchema, getDb, closeDb, startWarehouse3dChangeListener } from './db/client.js';
import { config, sequences } from './db/schema.js';
import { startAutoLineScheduler } from './services/autoLineNotifications.js';
import { bumpFromDatabase } from './lib/bus.js';
import { synchronizeWarehouseGeometryFromLocationMaster } from './services/state.js';

async function main() {
  // Ensure schema + singletons exist before serving (safe/idempotent).
  await applySchema();
  const db = getDb();
  await db.insert(config).values({ id: 1 }).onConflictDoNothing({ target: config.id });
  await db
    .insert(sequences)
    .values([{ name: 'do', value: 0 }, { name: 'emp', value: 0 }])
    .onConflictDoNothing({ target: sequences.name });
  let locationMasterSync = Promise.resolve();
  const stopWarehouse3dChangeListener = await startWarehouse3dChangeListener((scope) => {
    if (scope === 'warehouse3d') {
      bumpFromDatabase(scope);
      return;
    }
    /* Notifications are asynchronous and may arrive in a burst during a bulk
       import. Serialize geometry projection so an older read never wins over
       a newer Location Master commit. */
    locationMasterSync = locationMasterSync
      .then(() => synchronizeWarehouseGeometryFromLocationMaster(db))
      .then(() => { bumpFromDatabase('warehouse3d'); })
      .catch((error) => console.error('[db] location master → 3D sync failed', error));
  });

  const app = createApp();
  const stopAutoLineScheduler = startAutoLineScheduler(db);
  const server = app.listen(env.port, () => {
    console.log(`[boxtrace-api] listening on http://localhost:${env.port}`);
    console.log(`[boxtrace-api] driver: ${env.usePglite ? 'PGlite (in-process)' : 'PostgreSQL'}`);
  });

  const shutdown = async () => {
    stopAutoLineScheduler();
    await stopWarehouse3dChangeListener();
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
