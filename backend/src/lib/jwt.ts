import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../env.js';

export interface JwtPayload {
  sub: number | string; // users.id (number) or employees.id (text) — see employeeId
  username: string;
  name: string;
  role: string;
  /** Set only when this token was issued to an employee account (see
   *  POST /api/auth/login's employees fallback) rather than a `users` row —
   *  `sub` is that employee's id either way, this just disambiguates which
   *  table it points at for anything that needs to tell the two apart. */
  employeeId?: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.jwtSecret) as unknown as JwtPayload;
}
