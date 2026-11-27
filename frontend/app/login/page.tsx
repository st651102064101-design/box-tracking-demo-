'use client';

import { useEffect, useState } from 'react';
import { ApiError, login, setToken, getBranding, type SystemBranding } from '@/lib/api';
import { LanguageToggle, useI18n, type TranslationKey } from '@/lib/i18n';
import { isResetLinkPage, savedResetEmail, sendResetLink, tokenFromResetLink } from '@/lib/firebaseAuth';
import { resetPasswordWithFirebase } from '@/lib/api';

type FieldName = 'username' | 'password';

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
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ key: TranslationKey } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  // The account offered for one-click quick login (last account that signed
  // in on this device, or ?u=<username> from the app's "switch account"
  // flow — both are "you already told us who you are, just confirm with
  // your password" cases, so they share the same compact UI below).
  const [quickUser, setQuickUser] = useState('');
  /* "signin" is the normal form; "forgot" asks for the email; "newpass" is
     opened from the email link and sets the new password. */
  const [mode, setMode] = useState<'signin' | 'forgot' | 'sent' | 'newpass'>('signin');
  const [resetEmail, setResetEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const isThai = locale === 'th';
  useEffect(() => {
    try {
      if (isResetLinkPage()) {
        setMode('newpass');
        setResetEmail(savedResetEmail());
      }
    } catch {
      /* Firebase not reachable: stay on the normal sign-in form */
    }
  }, []);

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await sendResetLink(resetEmail.trim());
      setError('');
      setFieldErrors({});
      setMode('sent');
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : (isThai ? 'ส่งลิงก์ไม่สำเร็จ ตรวจอีเมลแล้วลองอีกครั้ง' : 'Could not send the link. Check the email and try again.'));
      setBusy(false);
    }
  }

  async function setNewPasswordNow(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword !== newPassword2) {
      setError(isThai ? 'รหัสผ่านสองช่องไม่ตรงกัน' : 'The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const idToken = await tokenFromResetLink(resetEmail.trim());
      await resetPasswordWithFirebase(idToken, newPassword);
      window.history.replaceState({}, '', '/login');
      setMode('signin');
      setNewPassword('');
      setNewPassword2('');
      setBusy(false);
      setError('');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : (isThai ? 'ตั้งรหัสผ่านไม่สำเร็จ' : 'Could not set the password.'));
      setBusy(false);
    }
  }
  const [done, setDone] = useState(false);
  // true once the person picks "ไม่ใช่ฉัน" and wants the plain username field back.
  const [useOtherAccount, setUseOtherAccount] = useState(false);

  // ?u= (from switchToEmployee in legacy.html) takes priority over whatever
  // was last remembered on this device — it's an explicit "log in as this
  // person" request, not a passive default.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('reason') === 'session-expired') {
      setNotice({ key: 'login.sessionExpired' });
    }
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

  function fieldMessage(name: FieldName, value: string) {
    const clean = value.trim();
    if (name === 'username' && !clean) return t('login.validation.usernameRequired');
    if (name === 'password' && !value) return t('login.validation.passwordRequired');
    return '';
  }

  useEffect(() => {
    const values: Record<FieldName, string> = { username, password };
    setFieldErrors((current) => Object.fromEntries(
      Object.keys(current).map((name) => {
        const field = name as FieldName;
        return [field, fieldMessage(field, values[field]) || undefined];
      }),
    ));
  }, [locale, t, username, password]);

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
    const active: Array<[FieldName, string]> = [['username', username], ['password', password]];
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

  const showQuickLogin = !!quickUser && !useOtherAccount;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateCurrentMode()) return;
    setError('');
    setNotice(null);
    setBusy(true);
    try {
      const trimmed = username.trim();
      const res = await login(trimmed, password);
      setToken(res.token);
      window.localStorage.setItem(LAST_USER_KEY, trimmed);
      window.location.replace(res.user.firstSetupRequired ? '/onboarding' : '/');
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.errors).length) {
        setFieldErrors((current) => ({ ...current, ...err.errors }));
        window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      }
      setError(err instanceof Error ? err.message : t('common.actionFailed'));
      setBusy(false);
    }
  }

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

        <h2 className="mb-4 text-xl font-bold tracking-tight text-ink">{t('login.title.signIn')}</h2>

        {/* Quick login — this device already knows who signed in last (or the
            app sent us here with ?u=), so skip straight to "confirm with your
            password" instead of making them retype a username every time.
            "ไม่ใช่ฉัน" swaps back to a blank field without losing quickUser,
            so it's just as fast to switch to someone else. */}
        {mode === 'signin' && showQuickLogin && (
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

        {mode === 'signin' && <form onSubmit={submit} className="space-y-3">
          {!showQuickLogin && (
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

          {useOtherAccount && quickUser && (
            <button
              type="button"
              onClick={useQuickAgain}
              className="-mt-1 block text-xs font-medium text-ink-2/60 hover:text-ink"
            >
              {t('login.quickAgain', { username: quickUser })}
            </button>
          )}

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
          <button
            type="button"
            onClick={() => { setError(''); setMode('forgot'); }}
            className="-mt-1 block text-xs font-medium text-ink-2/60 hover:text-ink"
          >
            {isThai ? 'ลืมรหัสผ่าน?' : 'Forgot password?'}
          </button>

          {notice && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">{t(notice.key)}</p>}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-ink py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('common.processing') : t('login.submit.signIn')}
          </button>
        </form>}
        {mode === 'forgot' && (
          <form onSubmit={sendLink} className="space-y-3">
            <p className="text-sm text-ink-2/80">{isThai ? 'กรอกอีเมลของบัญชี เราจะส่งลิงก์ให้ตั้งรหัสผ่านใหม่' : 'Enter the account email. We will send a link to set a new password.'}</p>
            <input
              type="email"
              required
              value={resetEmail}
              onChange={(e) => setResetEmail(e.target.value)}
              placeholder="name@company.com"
              autoComplete="email"
              className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm text-ink"
            />
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={busy} className="w-full rounded-xl bg-ink py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
              {busy ? t('common.processing') : (isThai ? 'ส่งลิงก์' : 'Send link')}
            </button>
            <button type="button" onClick={() => { setError(''); setMode('signin'); }} className="block w-full text-center text-xs font-medium text-ink-2/60 hover:text-ink">
              {isThai ? 'กลับไปเข้าสู่ระบบ' : 'Back to sign in'}
            </button>
          </form>
        )}
        {mode === 'sent' && (
          <div className="space-y-4 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✉</div>
            <div>
              <p className="text-base font-semibold text-ink">{isThai ? 'ส่งลิงก์แล้ว' : 'Link sent'}</p>
              <p className="mt-1 text-sm text-ink-2/80">
                {isThai ? 'เปิดอีเมล ' : 'Open the email '}<span className="font-semibold">{resetEmail}</span>{isThai ? ' แล้วกดลิงก์เพื่อตั้งรหัสผ่านใหม่' : ' and click the link to set a new password.'}
              </p>
              <p className="mt-2 text-xs text-ink-2/60">{isThai ? 'ไม่ได้รับภายใน 1 นาที? ตรวจโฟลเดอร์สแปม หรือติดต่อผู้ดูแลระบบ' : "Not received within a minute? Check spam, or contact the system admin."}</p>
            </div>
            <button type="button" onClick={() => { setMode('signin'); setResetEmail(''); }} className="w-full rounded-xl bg-ink py-3 text-sm font-semibold text-white transition hover:opacity-90">
              {isThai ? 'กลับไปเข้าสู่ระบบ' : 'Back to sign in'}
            </button>
          </div>
        )}
        {mode === 'newpass' && (
          <form onSubmit={setNewPasswordNow} className="space-y-3">
            <p className="text-sm text-ink-2/80">{isThai ? 'ตั้งรหัสผ่านใหม่สำหรับบัญชีนี้' : 'Set a new password for this account.'}</p>
            {!resetEmail && (
              <input type="email" required value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} placeholder="name@company.com" className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm text-ink" />
            )}
            <input type="password" required minLength={10} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={isThai ? 'รหัสผ่านใหม่ (อย่างน้อย 10 ตัว มีพิมพ์เล็ก พิมพ์ใหญ่ และตัวเลข)' : 'New password (10+ chars, lower, UPPER and a digit)'} autoComplete="new-password" className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm text-ink" />
            <input type="password" required value={newPassword2} onChange={(e) => setNewPassword2(e.target.value)} placeholder={isThai ? 'พิมพ์รหัสผ่านใหม่อีกครั้ง' : 'Repeat the new password'} autoComplete="new-password" className="w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm text-ink" />
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={busy} className="w-full rounded-xl bg-ink py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
              {busy ? t('common.processing') : (isThai ? 'บันทึกรหัสผ่านใหม่' : 'Save new password')}
            </button>
          </form>
        )}
        {done && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">{isThai ? 'ตั้งรหัสผ่านใหม่แล้ว เข้าสู่ระบบได้เลย' : 'Password set. You can sign in now.'}</p>}

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
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full rounded-xl border bg-black/[0.02] px-3 py-2.5 text-sm text-ink outline-none transition focus:bg-white ${error ? 'border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/15' : 'border-black/10 focus:border-black/30'}`}
      />
      {error && <span id={errorId} role="alert" className="mt-1 block text-xs font-medium text-red-600">{error}</span>}
    </label>
  );
}
