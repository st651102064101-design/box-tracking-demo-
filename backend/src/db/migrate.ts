/**
 * Bootstrap / migrate the database schema, then ensure singleton rows exist.
 * Run with: `npm run db:migrate`
 */
import { getDb, applySchema, closeDb } from './client.js';
import { config, sequences } from './schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('[migrate] applying schema…');
  await applySchema();

  const db = getDb();
  // Ensure the config singleton exists.
  await db
    .insert(config)
    .values({ id: 1 })
    .onConflictDoNothing({ target: config.id });
  // Ensure the two known sequences exist.
  await db
    .insert(sequences)
    .values([{ name: 'do', value: 0 }, { name: 'emp', value: 0 }])
    .onConflictDoNothing({ target: sequences.name });

  // Touch the DB so misconfiguration surfaces immediately.
  await db.execute(sql`select 1`);
  console.log('[migrate] done ✓');
  await closeDb();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
