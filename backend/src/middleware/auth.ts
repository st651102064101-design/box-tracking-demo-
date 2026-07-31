import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/** Requires a valid `Authorization: Bearer <jwt>` header. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'unauthorized', message: 'ต้องเข้าสู่ระบบก่อน' });
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }
}

/** Requires `req.user.role` to be one of `roles`. Must run after `requireAuth`. */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'unauthorized', message: 'ต้องเข้าสู่ระบบก่อน' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: 'คุณไม่มีสิทธิ์ทำรายการนี้' });
    }
    next();
  };
}
