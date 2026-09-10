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
    // Upgrade the original demo rack geometry to the selective-rack standard:
    // 2.7 m bay, 1.1 m depth and 1.5 m level pitch. The profile marker keeps
    // later restarts and state syncs from overwriting deliberate manual edits.
    await db.execute(sql `
    WITH candidates AS (
      SELECT id, rack_id, shelf_code, slot_code,
        row_number() OVER (PARTITION BY rack_id, shelf_code ORDER BY slot_code) AS bay_no,
        count(*) OVER (PARTITION BY rack_id, shelf_code) AS bay_count,
        dense_rank() OVER (PARTITION BY rack_id ORDER BY shelf_code) AS level_no
      FROM slots
      WHERE COALESCE(data->>'geometryProfile', '') IN ('', 'three-metre-bay')
    )
    UPDATE slots AS s
    SET local_x_cm = (c.bay_no - (c.bay_count + 1) / 2.0) * 270,
        local_y_cm = (c.level_no - 0.5) * 150,
        width_cm = 270,
        height_cm = 140,
        depth_cm = 110,
        data = s.data || '{"geometryProfile":"selective-270-bay"}'::jsonb
    FROM candidates AS c
    WHERE s.id = c.id;
  `);
    await db.execute(sql `
    WITH bay_counts AS (
      SELECT rack_id,
        count(DISTINCT slot_code)::double precision AS bay_count,
        count(DISTINCT shelf_code)::double precision AS level_count
      FROM slots
      WHERE COALESCE(data->>'geometryProfile', '') IN ('', 'three-metre-bay', 'selective-270-bay')
      GROUP BY rack_id
    )
    UPDATE racks AS r
    SET width_cm = (b.bay_count * 270) + 20,
        height_cm = (b.level_count * 150) + 20,
        depth_cm = 110,
        data = r.data || '{"geometryProfile":"selective-270-bay"}'::jsonb
    FROM bay_counts AS b
    WHERE r.id = b.rack_id
      AND COALESCE(r.data->>'geometryProfile', '') IN ('', 'three-metre-bay');
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
    await db.execute(sql `select 1`);
    console.log('[migrate] done ✓');
    await closeDb();
}
main().catch((err) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map