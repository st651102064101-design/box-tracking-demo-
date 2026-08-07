import { verifyToken } from '../lib/jwt.js';
import { env } from '../env.js';
/** Requires a valid `Authorization: Bearer <jwt>` header. */
export function requireAuth(req, res, next) {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'unauthorized', message: 'ต้องเข้าสู่ระบบก่อน' });
    }
    try {
        req.user = verifyToken(token);
        next();
    }
    catch {
        return res.status(401).json({ error: 'invalid_token', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    }
}
/**
 * Requires the `X-API-Key` header to match `env.apiKey` — a second,
 * independent factor on top of the JWT so a leaked bearer token alone
 * still can't call the API. A no-op when `env.apiKey` is unset (the
 * default), so this doesn't break the legacy.html web client, which has no
 * way to be handed a PDA-specific key today; set API_KEY to actually
 * enforce it once every real client has been given the value out of band.
 */
export function requireApiKey(req, res, next) {
    if (!env.apiKey)
        return next();
    const key = req.headers['x-api-key'];
    if (key !== env.apiKey) {
        return res.status(401).json({ error: 'invalid_api_key', message: 'ไม่ผ่านการตรวจสอบ API key' });
    }
    next();
}
/** Requires `req.user.role` to be one of `roles`. Must run after `requireAuth`. */
export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'unauthorized', message: 'ต้องเข้าสู่ระบบก่อน' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'forbidden', message: 'คุณไม่มีสิทธิ์ทำรายการนี้' });
        }
        next();
    };
}
//# sourceMappingURL=auth.js.map