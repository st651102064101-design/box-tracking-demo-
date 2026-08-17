import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

/** Wrap async route handlers so thrown/rejected errors reach the error middleware. */
export function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(
  fn: T,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'not_found' });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'validation_error', issues: err.issues });
  }
  const anyErr = err as { status?: number; message?: string; code?: string };
  const status = anyErr?.status ?? 500;
  if (status >= 500) {
    /* Anything landing here without an explicit status is a bug, not a message
       for the person using the app. Echoing it verbatim leaked the driver's own
       text — a PUT /api/state conflict used to answer with
       {"error":"23505","message":"duplicate key value violates unique
       constraint \"boxes_pkey\""}, handing out table and constraint names.
       Log the real error, answer with something readable. */
    console.error('[error]', err);
    return res.status(status).json({
      error: 'internal_error',
      message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง',
    });
  }
  res.status(status).json({
    error: anyErr?.code ?? 'error',
    message: anyErr?.message ?? 'เกิดข้อผิดพลาด',
  });
}

/** Small helper to throw HTTP errors with a status + Thai message. */
export function httpError(status: number, message: string, code?: string) {
  const e = new Error(message) as Error & { status: number; code?: string };
  e.status = status;
  e.code = code;
  return e;
}
