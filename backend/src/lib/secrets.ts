/** Values that are published in this repository, so they protect nothing. */
const PUBLISHED = new Set([
  'change-me-in-production',
  'change-me-in-production-please-use-a-long-random-string',
  'BoxTrace-LPR-2026',
]);

/** Why a production secret is unusable, or null when it is acceptable. */
export function weakSecretReason(value: string | undefined, minLength: number): string | null {
  if (!value) return 'is not set';
  if (PUBLISHED.has(value) || value.startsWith('dev-insecure')) return 'is a published default';
  if (value.length < minLength) return `is shorter than ${minLength} characters`;
  return null;
}

/** For the account created on first run. */
export function weakAdminPassword(value: string): boolean {
  return value.length < 10 || ['admin123', 'password123', '1234567890'].includes(value.toLowerCase());
}
