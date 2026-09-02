/** Tiny fetch wrapper for the SmartTrace API (same-origin via Next rewrites). */
const TOKEN_KEY = 'smarttrace_jwt';

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
  email?: string | null;
  employeeId?: string | null;
  active?: boolean;
  firstSetupRequired?: boolean;
}

export interface SystemBranding {
  systemName: string;
  subtitle: string;
  logoData: string | null;
}

export class ApiError extends Error {
  status: number;
  errors: Record<string, string>;

  constructor(message: string, status: number, errors: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
  }
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
    const issues: { message?: string; path?: Array<string | number> }[] = Array.isArray(body?.issues) ? body.issues : [];
    const issueText = issues.map((i) => i.message).filter(Boolean).join(' · ');
    const fieldErrors: Record<string, string> = body?.errors && typeof body.errors === 'object' ? { ...body.errors } : {};
    issues.forEach((issue) => {
      const field = issue.path?.[0];
      if (typeof field === 'string' && issue.message && !fieldErrors[field]) fieldErrors[field] = issue.message;
    });
    throw new ApiError(issueText || body?.message || body?.error || `HTTP ${res.status}`, res.status, fieldErrors);
  }
  return body as T;
}

export function login(username: string, password: string) {
  return request<{ token: string; user: AuthUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function getBranding() {
  return request<SystemBranding>('/branding');
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
  return request<{ user: AuthUser; role?: { key?: string | null }; identityConflicts?: unknown[] }>('/auth/me');
}

export interface FirstSetupInput {
  name: string;
  email: string;
  username: string;
  password: string;
  phone: string;
  position: string;
  department: string;
  warehouse: string;
}

export function completeFirstSetup(input: FirstSetupInput) {
  return request<{ token: string; user: AuthUser }>('/auth/first-setup', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
