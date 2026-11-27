/* Checks a Firebase Auth ID token without any Firebase secret: Google publishes
   the certificates for securetoken@ and the token is an RS256 JWT signed by one
   of them. Only the public project id is needed. */
import jwt from 'jsonwebtoken';

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

type Certs = Record<string, string>;
let cache: { certs: Certs; expiresAt: number } | null = null;

async function loadCerts(fetchImpl: typeof fetch = fetch): Promise<Certs> {
  if (cache && cache.expiresAt > Date.now()) return cache.certs;
  const res = await fetchImpl(CERTS_URL);
  if (!res.ok) throw new Error('firebase_certs_unavailable');
  const certs = (await res.json()) as Certs;
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '');
  cache = { certs, expiresAt: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
  return certs;
}

export type FirebaseClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  firebase?: { sign_in_provider?: string };
};

/** Returns the verified claims, or throws. */
export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
  certsOverride?: Certs,
): Promise<FirebaseClaims> {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded && typeof decoded === 'object' ? (decoded.header as { kid?: string }).kid : undefined;
  if (!kid) throw new Error('invalid_token');
  const certs = certsOverride ?? (await loadCerts());
  const pem = certs[kid];
  if (!pem) throw new Error('invalid_token');
  const claims = jwt.verify(token, pem, {
    algorithms: ['RS256'],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  }) as FirebaseClaims;
  if (!claims.sub) throw new Error('invalid_token');
  return claims;
}

/** For tests: forget cached certificates. */
export function resetFirebaseCertCache() {
  cache = null;
}
