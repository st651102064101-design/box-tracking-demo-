import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { loginSchema, registerSchema } from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

/** POST /api/auth/register — create a user account. */
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const db = getDb();
    const existing = await db.select().from(users).where(eq(users.username, input.username));
    if (existing.length) throw httpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว', 'username_taken');

    const passwordHash = await hashPassword(input.password);
    const [row] = await db
      .insert(users)
      .values({ username: input.username, passwordHash, name: input.name, role: input.role })
      .returning();

    const token = signToken({ sub: row.id, username: row.username, name: row.name, role: row.role });
    res.status(201).json({ token, user: publicUser(row) });
  }),
);

/** POST /api/auth/login — exchange credentials for a JWT. */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const db = getDb();
    const [row] = await db.select().from(users).where(eq(users.username, input.username));
    if (!row || !(await verifyPassword(input.password, row.passwordHash))) {
      throw httpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'invalid_credentials');
    }
    const token = signToken({ sub: row.id, username: row.username, name: row.name, role: row.role });
    res.json({ token, user: publicUser(row) });
  }),
);

/** GET /api/auth/me — current user from the bearer token. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  }),
);

function publicUser(row: typeof users.$inferSelect) {
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}
