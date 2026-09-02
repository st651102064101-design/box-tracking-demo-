'use client';

import { useEffect, useState } from 'react';
import { ApiError, login, forgotPassword, resetPassword, setToken, getBranding, type SystemBranding } from '@/lib/api';
import { LanguageToggle, useI18n, type TranslationKey } from '@/lib/i18n';

type Mode = 'login' | 'forgot-request' | 'forgot-reset';
type FieldName = 'username' | 'password' | 'otp' | 'newPassword';

// Key for remembering who last signed in on this device, so the login screen
// can skip straight to "just type your password" instead of making them
// retype a username every single time — the same quick-switch pattern as a
// phone/OS lock screen. Plain username only (never a password), so the risk
// of keeping it in localStorage is the same as any "remember me" field.
const LAST_USER_KEY = 'st_last_login_user';

export default function LoginPage() {
  const { locale, t } = useI18n();
  const [branding, setBranding] = useState<SystemBranding>({
    systemName: 'Smart Tracking',
    subtitle: '',
    logoData: null,
  });
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ key: TranslationKey; params?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  // The account offered for one-click quick login (last account that signed
  // in on this device, or ?u=<username> from the app's "switch account"
  // flow — both are "you already told us who you are, just confirm with
  // your password" cases, so they share the same compact UI below).
  const [quickUser, setQuickUser] = useState('');
  // true once the person picks "ไม่ใช่ฉัน" and wants the plain username field back.
  const [useOtherAccount, setUseOtherAccount] = useState(false);

  // ?u= (from switchToEmployee in legacy.html) takes priority over whatever
  // was last remembered on this device — it's an explicit "log in as this
  // person" request, not a passive default.
  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get('u');
    const remembered = u || window.localStorage.getItem(LAST_USER_KEY) || '';
    if (remembered) {
      setQuickUser(remembered);
      setUsername(remembered);
    }
  }, []);

  useEffect(() => {
    getBranding().then(setBranding).catch(() => undefined);
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setNotice(null);
    setFieldErrors({});
    setTouched({});
  }

  function fieldMessage(name: FieldName, value: string) {
    const clean = value.trim();
    if (name === 'username' && !clean) return t('login.validation.usernameRequired');
    if (name === 'password' && !value) return t('login.validation.passwordRequired');
    if (name === 'otp' && !/^\d{6}$/.test(clean)) return t('login.validation.otpLength');
    if (name === 'newPassword' && value.length < 10) return t('password.validation.minLength');
    if (name === 'newPassword' && !/[a-z]/.test(value)) return t('password.validation.lowercase');
    if (name === 'newPassword' && !/[A-Z]/.test(value)) return t('password.validation.uppercase');
    if (name === 'newPassword' && !/\d/.test(value)) return t('password.validation.number');
    if (name === 'newPassword' && !/[^A-Za-z0-9]/.test(value)) return t('password.validation.special');
    return '';
  }

  useEffect(() => {
    const values: Record<FieldName, string> = { username, password, otp, newPassword };
    setFieldErrors((current) => Object.fromEntries(
      Object.keys(current).map((name) => {
        const field = name as FieldName;
        return [field, fieldMessage(field, values[field]) || undefined];
      }),
    ));
  }, [locale, t, username, password, otp, newPassword]);

  function updateField(name: FieldName, value: string, setter: (value: string) => void) {
    setter(value);
    if (touched[name] || fieldErrors[name]) {
      const message = fieldMessage(name, value);
      setFieldErrors((current) => ({ ...current, [name]: message || undefined }));
    }
  }

  function blurField(name: FieldName, value: string) {
    setTouched((current) => ({ ...current, [name]: true }));
    const message = fieldMessage(name, value);
    setFieldErrors((current) => ({ ...current, [name]: message || undefined }));
  }

  function validateCurrentMode() {
    const active: Array<[FieldName, string]> =
      mode === 'login'
        ? [['username', username], ['password', password]]
        : mode === 'forgot-request'
          ? [['username', username]]
          : [['otp', otp], ['newPassword', newPassword]];
    const next: Partial<Record<FieldName, string>> = {};
    active.forEach(([name, value]) => {
      const message = fieldMessage(name, value);
      if (message) next[name] = message;
    });
    setTouched(Object.fromEntries(active.map(([name]) => [name, true])));
    setFieldErrors(next);
    if (Object.keys(next).length) {
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return false;
    }
    return true;
  }

  // "ไม่ใช่ฉัน" — drop back to a blank, editable username field without
  // forgetting quickUser, so "กลับไปเข้าสู่ระบบด้วย <quickUser>" can restore
  // the quick-login card without the person having to type the name again.
  function useOther() {
    setUseOtherAccount(true);
    setUsername('');
    setError('');
  }
  function useQuickAgain() {
    setUseOtherAccount(false);
    setUsername(quickUser);
    setError('');
  }

  const showQuickLogin = mode === 'login' && !!quickUser && !useOtherAccount;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateCurrentMode()) return;
    setError('');
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        const trimmed = username.trim();
        const res = await login(trimmed, password);
        setToken(res.token);
        window.localStorage.setItem(LAST_USER_KEY, trimmed);
        window.location.replace(res.user.firstSetupRequired ? '/onboarding' : '/');
        return;
      }
      if (mode === 'forgot-request') {
        const res = await forgotPassword(username.trim());
        setNotice(
          res.sentTo
            ? { key: 'login.otp.sent', params: { destination: res.sentTo } }
            : { key: 'login.otp.generic' },
        );
        setMode('forgot-reset');
        setBusy(false);
        return;
      }
      if (mode === 'forgot-reset') {
        const res = await resetPassword(username.trim(), otp.trim(), newPassword);
        setToken(res.token);
        window.location.replace('/');
        return;
      }
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.errors).length) {
        setFieldErrors((current) => ({ ...current, ...err.errors }));
        window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      }
      setError(err instanceof Error ? err.message : t('common.actionFailed'));
      setBusy(false);
    }
  }

  const title = mode === 'login' ? t('login.title.signIn') : mode === 'forgot-request' ? t('login.title.forgot') : t('login.title.reset');
  const submitLabel =
    mode === 'login' ? t('login.submit.signIn') : mode === 'forgot-request' ? t('login.submit.sendOtp') : t('login.submit.reset');

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-[#f5f5f7] px-4">
      <div className="absolute right-4 top-4"><LanguageToggle /></div>
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-[0_24px_70px_rgba(0,0,0,.10)]">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-xl bg-ink text-xl font-black text-white">
            {branding.logoData ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoData} alt={branding.systemName} className="h-full w-full object-cover" />
            ) : (
              branding.systemName.charAt(0).toUpperCase()
            )}
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-ink">{branding.systemName}</h1>
            <p className="-mt-0.5 text-xs text-ink-2/70">{branding.subtitle || t('login.subtitleFallback')}</p>
          </div>
        </div>

        <h2 className="mb-4 text-xl font-bold tracking-tight text-ink">{title}</h2>

        {/* Quick login — this device already knows who signed in last (or the
            app sent us here with ?u=), so skip straight to "confirm with your
            password" instead of making them retype a username every time.
            "ไม่ใช่ฉัน" swaps back to a blank field without losing quickUser,
            so it's just as fast to switch to someone else. */}
        {showQuickLogin && (
          <div className="mb-3 flex items-center gap-3 rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2.5">
            <div className="grid h-9 w-9 flex-none place-items-center rounded-full bg-ink text-sm font-bold text-white">
              {quickUser.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-ink-2/60">{t('login.lastSignedInAs')}</p>
              <p className="truncate text-sm font-semibold text-ink">{quickUser}</p>
            </div>
            <button
              type="button"
              onClick={useOther}
              className="flex-none text-xs font-medium text-ink-2/60 hover:text-ink"
            >
              {t('login.notMe')}
            </button>
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          {mode !== 'forgot-reset' && !showQuickLogin && (
            <Field
              id="username"
              label={t('login.username.label')}
              value={username}
              onChange={(value) => updateField('username', value, setUsername)}
              onBlur={() => blurField('username', username)}
              error={fieldErrors.username}
              placeholder={t('login.username.placeholder')}
              autoFocus
              autoComplete="username"
            />
          )}

          {mode === 'login' && useOtherAccount && quickUser && (
            <button
              type="button"
              onClick={useQuickAgain}
              className="-mt-1 block text-xs font-medium text-ink-2/60 hover:text-ink"
            >
              {t('login.quickAgain', { username: quickUser })}
            </button>
          )}

          {mode === 'forgot-reset' && (
            <>
              <p className="rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-ink-2/70">
                {t('login.account')} <span className="font-semibold text-ink">{username}</span>
              </p>
              <Field
                id="otp"
                label={t('login.otp.label')}
                value={otp}
                onChange={(v) => updateField('otp', v.replace(/\D/g, '').slice(0, 6), setOtp)}
                onBlur={() => blurField('otp', otp)}
                error={fieldErrors.otp}
                placeholder="000000"
                maxLength={6}
                autoFocus
              />
              <Field
                id="new-password"
                label={t('login.password.newLabel')}
                value={newPassword}
                onChange={(value) => updateField('newPassword', value, setNewPassword)}
                onBlur={() => blurField('newPassword', newPassword)}
                error={fieldErrors.newPassword}
                type="password"
                placeholder={t('login.password.newPlaceholder')}
                autoComplete="new-password"
              />
            </>
          )}

          {mode === 'login' && (
            <Field
              id="password"
              label={t('login.password.label')}
              value={password}
              onChange={(value) => updateField('password', value, setPassword)}
              onBlur={() => blurField('password', password)}
              error={fieldErrors.password}
              type="password"
              placeholder="••••••"
              autoFocus={showQuickLogin}
              autoComplete="current-password"
            />
          )}

          {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{t(notice.key, notice.params)}</p>}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-ink py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('common.processing') : submitLabel}
          </button>
        </form>

        {mode === 'login' && (
          <button
            type="button"
            onClick={() => switchMode('forgot-request')}
            className="mt-3 w-full text-center text-sm text-ink-2/70 hover:text-ink"
          >
            {t('login.forgotQuestion')}
          </button>
        )}

        {(mode === 'forgot-request' || mode === 'forgot-reset') && (
          <button
            type="button"
            onClick={() => switchMode('login')}
            className="mt-3 w-full text-center text-sm text-ink-2/70 hover:text-ink"
          >
            {t('login.back')}
          </button>
        )}

        {process.env.NODE_ENV !== 'production' && (
          <p className="mt-6 text-center text-xs text-ink-2/50">
            {t('login.devOnly')}
          </p>
        )}
      </div>
    </main>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoFocus,
  autoComplete,
  maxLength,
  error,
  onBlur,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  maxLength?: number;
  error?: string;
  onBlur?: () => void;
}) {
  const inputId = `login-${id}`;
  const errorId = `${inputId}-error`;
  return (
    <label className="block" htmlFor={inputId}>
      <span className="mb-1 block text-xs font-medium text-ink-2/70">{label}</span>
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        maxLength={maxLength}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full rounded-xl border bg-black/[0.02] px-3 py-2.5 text-sm text-ink outline-none transition focus:bg-white ${error ? 'border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/15' : 'border-black/10 focus:border-black/30'}`}
      />
      {error && <span id={errorId} role="alert" className="mt-1 block text-xs font-medium text-red-600">{error}</span>}
    </label>
  );
}
