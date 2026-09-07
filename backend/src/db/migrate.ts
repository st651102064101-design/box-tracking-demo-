/**
 * Bootstrap / migrate the database schema, then ensure singleton rows exist.
 * Run with: `npm run db:migrate`
 */
import { getDb, applySchema, closeDb } from './client.js';
import { config, sequences } from './schema.js';
import { seedRoles } from './seedRoles.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('[migrate] applying schema…');
  await applySchema();

  const db = getDb();
  // Upgrade the original demo rack geometry once to the agreed three-metre
  // clear-bay standard. The profile marker keeps later restarts and state
  // syncs from overwriting deliberate manual geometry edits.
  await db.execute(sql`
    WITH candidates AS (
      SELECT id, rack_id, shelf_code, slot_code,
        row_number() OVER (PARTITION BY rack_id, shelf_code ORDER BY slot_code) AS bay_no,
        count(*) OVER (PARTITION BY rack_id, shelf_code) AS bay_count
      FROM slots
      WHERE COALESCE(data->>'geometryProfile', '') = ''
    )
    UPDATE slots AS s
    SET local_x_cm = (c.bay_no - (c.bay_count + 1) / 2.0) * 300,
        width_cm = 300,
        data = s.data || '{"geometryProfile":"three-metre-bay"}'::jsonb
    FROM candidates AS c
    WHERE s.id = c.id;
  `);
  await db.execute(sql`
    WITH bay_counts AS (
      SELECT rack_id, count(DISTINCT slot_code)::double precision AS bay_count
      FROM slots
      WHERE COALESCE(data->>'geometryProfile', '') = 'three-metre-bay'
      GROUP BY rack_id
    )
    UPDATE racks AS r
    SET width_cm = (b.bay_count * 300) + 20,
        data = r.data || '{"geometryProfile":"three-metre-bay"}'::jsonb
    FROM bay_counts AS b
    WHERE r.id = b.rack_id
      AND COALESCE(r.data->>'geometryProfile', '') = '';
  `);
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

  // Built-in roles must exist before any request runs: with no roles at all
  // every permission check resolves to "denied" and locks out even the admin.
  await seedRoles();

  // Touch the DB so misconfiguration surfaces immediately.
  await db.execute(sql`select 1`);
  console.log('[migrate] done ✓');
  await closeDb();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
