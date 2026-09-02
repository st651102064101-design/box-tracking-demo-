/**
 * Seed the database with the admin account (and ensure schema/singletons).
 * The rich demo warehouse data is produced by the frontend's own `seedDemo()`
 * on first run and synced up via PUT /api/state, so we keep this minimal.
 *
 * Run with: `npm run db:seed`
 */
import { eq } from 'drizzle-orm';
import { applySchema, getDb, closeDb } from './db/client.js';
import { users, config, sequences } from './db/schema.js';
import { hashPassword } from './lib/password.js';
import { env } from './env.js';

async function main() {
  await applySchema();
  const db = getDb();

  await db.insert(config).values({ id: 1 }).onConflictDoNothing({ target: config.id });
  await db
    .insert(sequences)
    .values([{ name: 'do', value: 0 }, { name: 'emp', value: 0 }])
    .onConflictDoNothing({ target: sequences.name });

  const { username, password, name } = env.seedAdmin;
  const existing = await db.select().from(users).where(eq(users.username, username));
  if (existing.length) {
    console.log(`[seed] admin "${username}" already exists — skipping`);
  } else {
    await db.insert(users).values({
      username,
      passwordHash: await hashPassword(password),
      name,
      role: 'admin',
    });
    console.log(`[seed] created admin "${username}" (password: "${password}")`);
  }

  console.log('[seed] done ✓');
  await closeDb();
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
