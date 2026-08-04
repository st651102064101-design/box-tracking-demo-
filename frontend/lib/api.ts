/** Tiny fetch wrapper for the BoxTrace API (same-origin via Next rewrites). */
const TOKEN_KEY = 'boxtrace_jwt';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  role: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Zod validation failures come back as { error: 'validation_error', issues: [...] }
    // with no top-level message — each issue already carries a human-readable Thai
    // message (e.g. "รหัสผ่านอย่างน้อย 6 ตัวอักษร"), so surface those instead of the
    // generic error code.
    const issues: { message?: string }[] = Array.isArray(body?.issues) ? body.issues : [];
    const issueText = issues.map((i) => i.message).filter(Boolean).join(' · ');
    throw new Error(issueText || body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body as T;
}

export function login(username: string, password: string) {
  return request<{ token: string; user: AuthUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function forgotPassword(username: string) {
  return request<{ ok: true; sentTo: string | null }>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
}

export function resetPassword(username: string, otp: string, password: string) {
  return request<{ token: string; user: AuthUser }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ username, otp, password }),
  });
}

export function me() {
  return request<{ user: AuthUser }>('/auth/me');
}
