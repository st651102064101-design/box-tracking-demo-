import jwt from 'jsonwebtoken';
import { env } from '../env.js';
export function signToken(payload) {
    return jwt.sign(payload, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn,
    });
}
export function verifyToken(token) {
    return jwt.verify(token, env.jwtSecret);
}
//# sourceMappingURL=jwt.js.map