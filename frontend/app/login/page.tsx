'use client';

import { useEffect, useState } from 'react';
import { login, forgotPassword, resetPassword, setToken } from '@/lib/api';

type Mode = 'login' | 'forgot-request' | 'forgot-reset';

// Key for remembering who last signed in on this device, so the login screen
// can skip straight to "just type your password" instead of making them
// retype a username every single time — the same quick-switch pattern as a
// phone/OS lock screen. Plain username only (never a password), so the risk
// of keeping it in localStorage is the same as any "remember me" field.
const LAST_USER_KEY = 'st_last_login_user';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
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

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setNotice('');
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
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'login') {
        const trimmed = username.trim();
        const res = await login(trimmed, password);
        setToken(res.token);
        window.localStorage.setItem(LAST_USER_KEY, trimmed);
        window.location.replace('/');
        return;
      }
      if (mode === 'forgot-request') {
        const res = await forgotPassword(username.trim());
        setNotice(
          res.sentTo
            ? `ส่งรหัส OTP ไปที่ ${res.sentTo} แล้ว — กรอกรหัส 6 หลักด้านล่าง (มีอายุ 5 นาที)`
            : 'หากมีบัญชีนี้อยู่ในระบบ จะมีอีเมลส่งรหัส OTP ไปให้ — กรอกรหัส 6 หลักด้านล่าง',
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
      setError(err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ');
      setBusy(false);
    }
  }

  const title = mode === 'login' ? 'เข้าสู่ระบบ' : mode === 'forgot-request' ? 'ลืมรหัสผ่าน' : 'ตั้งรหัสผ่านใหม่';
  const submitLabel =
    mode === 'login' ? 'เข้าสู่ระบบ' : mode === 'forgot-request' ? 'ส่งรหัส OTP ทางอีเมล' : 'ตั้งรหัสผ่านใหม่และเข้าสู่ระบบ';

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f5f7] px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-[0_24px_70px_rgba(0,0,0,.10)]">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-xl font-black text-white">S</div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-ink">Smart Tracking Thai Summit</h1>
            <p className="-mt-0.5 text-xs text-ink-2/70">Returnable Asset Tracking</p>
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
              <p className="text-[11px] text-ink-2/60">เข้าสู่ระบบล่าสุดในชื่อ</p>
              <p className="truncate text-sm font-semibold text-ink">{quickUser}</p>
            </div>
            <button
              type="button"
              onClick={useOther}
              className="flex-none text-xs font-medium text-ink-2/60 hover:text-ink"
            >
              ไม่ใช่ฉัน
            </button>
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          {mode !== 'forgot-reset' && !showQuickLogin && (
            <Field
              label="ชื่อผู้ใช้ หรือ อีเมล"
              value={username}
              onChange={setUsername}
              placeholder="username หรือ name@company.com"
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
              กลับไปเข้าสู่ระบบด้วย “{quickUser}”
            </button>
          )}

          {mode === 'forgot-reset' && (
            <>
              <p className="rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-ink-2/70">
                บัญชี: <span className="font-semibold text-ink">{username}</span>
              </p>
              <Field
                label="รหัส OTP (6 หลัก)"
                value={otp}
                onChange={(v) => setOtp(v.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                autoFocus
              />
              <Field
                label="รหัสผ่านใหม่"
                value={newPassword}
                onChange={setNewPassword}
                type="password"
                placeholder="อย่างน้อย 6 ตัวอักษร"
                autoComplete="new-password"
              />
            </>
          )}

          {mode === 'login' && (
            <Field
              label="รหัสผ่าน"
              value={password}
              onChange={setPassword}
              type="password"
              placeholder="••••••"
              autoFocus={showQuickLogin}
              autoComplete="current-password"
            />
          )}

          {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-ink py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'กำลังดำเนินการ…' : submitLabel}
          </button>
        </form>

        {mode === 'login' && (
          <button
            type="button"
            onClick={() => switchMode('forgot-request')}
            className="mt-3 w-full text-center text-sm text-ink-2/70 hover:text-ink"
          >
            ลืมรหัสผ่าน?
          </button>
        )}

        {(mode === 'forgot-request' || mode === 'forgot-reset') && (
          <button
            type="button"
            onClick={() => switchMode('login')}
            className="mt-3 w-full text-center text-sm text-ink-2/70 hover:text-ink"
          >
            กลับไปเข้าสู่ระบบ
          </button>
        )}

        {process.env.NODE_ENV !== 'production' && (
          <p className="mt-6 text-center text-xs text-ink-2/50">
            Dev only — บัญชีเริ่มต้นตั้งจาก <code>SEED_ADMIN_*</code> env vars (ดู <code>npm run db:seed</code>)
          </p>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoFocus,
  autoComplete,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-2/70">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        maxLength={maxLength}
        className="w-full rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2.5 text-sm text-ink outline-none transition focus:border-black/30 focus:bg-white"
      />
    </label>
  );
}
