import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { verifyFirebaseIdToken } from '../src/services/firebaseIdToken.js';

const PROJECT = 'smarttrace-login';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const certs = { 'kid-1': pem };

function token(payload: Record<string, unknown>, opts: { kid?: string; key?: string; aud?: string; iss?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: 'u1', email: 'a@example.com', email_verified: true, aud: opts.aud ?? PROJECT, iss: opts.iss ?? `https://securetoken.google.com/${PROJECT}`, iat: now, exp: now + 600, firebase: { sign_in_provider: 'emailLink' }, ...payload },
    opts.key ?? pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    { algorithm: 'RS256', keyid: opts.kid ?? 'kid-1' },
  );
}

describe('Firebase ID token check', () => {
  beforeAll(() => undefined);
  it('accepts a token signed by Google for this project', async () => {
    const c = await verifyFirebaseIdToken(token({}), PROJECT, certs);
    expect(c.email).toBe('a@example.com');
  });
  it('rejects another project, an unknown key, a bad issuer and a forged signature', async () => {
    await expect(verifyFirebaseIdToken(token({}, { aud: 'other' }), PROJECT, certs)).rejects.toThrow();
    await expect(verifyFirebaseIdToken(token({}, { kid: 'nope' }), PROJECT, certs)).rejects.toThrow();
    await expect(verifyFirebaseIdToken(token({}, { iss: 'https://evil.example' }), PROJECT, certs)).rejects.toThrow();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(verifyFirebaseIdToken(token({}, { key: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }), PROJECT, certs)).rejects.toThrow();
  });
});
