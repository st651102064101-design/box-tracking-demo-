import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';
import { effectivePermissions } from '../lib/effectivePermissions.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
      /** Filled in by requirePermission/requireAnyPermission so a handler can
       *  do finer-grained checks without re-querying. */
      permissions?: string[];
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

/** Requires `req.user.role` to be one of `roles`. Must run after `requireAuth`.
 *  Superseded by `requirePermission` for anything RBAC covers — kept for the
 *  few checks that are about *which account type* is calling rather than what
 *  it is allowed to do. */
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

/**
 * Requires the caller's role to grant *every* permission listed. Must run
 * after `requireAuth`.
 *
 * This is the real access control — hiding a button in the UI is a courtesy,
 * not a boundary, so every mutating route carries one of these regardless of
 * what the frontend chooses to show.
 */
export function requirePermission(...perms: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'unauthorized', message: 'ต้องเข้าสู่ระบบก่อน' });
    }
    try {
      const eff = await effectivePermissions(req.user);
      req.permissions = eff.permissions;
      const granted = new Set(eff.permissions);
      const missing = perms.filter((p) => !granted.has(p));
      if (missing.length) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
          required: perms,
          missing,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Any one of `perms` is enough (e.g. role.manage OR permission.manage). */
export function requireAnyPermission(...perms: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'unauthorized', message: 'ต้องเข้าสู่ระบบก่อน' });
    }
    try {
      const eff = await effectivePermissions(req.user);
      req.permissions = eff.permissions;
      if (!perms.some((p) => eff.permissions.includes(p))) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
          required: perms,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
