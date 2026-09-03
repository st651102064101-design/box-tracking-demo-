import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { applySchema, getDb } from '../src/db/client.js';
import { config, sequences, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';

export interface TestCtx {
  app: Express;
  token: string;
}

/** Fresh schema + admin + a logged-in token, ready for Supertest. */
export async function bootstrap(): Promise<TestCtx> {
  await applySchema();
  const db = getDb();
  await db.insert(config).values({ id: 1 }).onConflictDoNothing({ target: config.id });
  await db
    .insert(sequences)
    .values([{ name: 'do', value: 0 }, { name: 'emp', value: 0 }])
    .onConflictDoNothing({ target: sequences.name });
  await db
    .insert(users)
    .values({ username: 'admin', passwordHash: await hashPassword('admin123'), name: 'Admin', role: 'admin' })
    .onConflictDoNothing({ target: users.username });

  const app = createApp();
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
  return { app, token: res.body.token as string };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
