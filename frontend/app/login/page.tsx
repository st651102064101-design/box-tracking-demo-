'use client';

import { useEffect, useState } from 'react';
import { login, forgotPassword, resetPassword, setToken } from '@/lib/api';

type Mode = 'login' | 'forgot-request' | 'forgot-reset';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Prefilled when arriving from the web app's "switch account" flow (see
  // switchToEmployee in legacy.html) — ?u=<their username>, so the person
  // just switching identity only has to type their own password, not
  // remember/retype the username they were just shown.
  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get('u');
    if (u) setUsername(u);
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setNotice('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'login') {
        const res = await login(username.trim(), password);
        setToken(res.token);
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
            <h1 className="text-lg font-bold tracking-tight text-ink">Smart Tracking</h1>
            <p className="-mt-0.5 text-xs text-ink-2/70">Returnable Asset Tracking</p>
          </div>
        </div>

        <h2 className="mb-4 text-xl font-bold tracking-tight text-ink">{title}</h2>

        <form onSubmit={submit} className="space-y-3">
          {mode !== 'forgot-reset' && (
            <Field
              label="ชื่อผู้ใช้ หรือ อีเมล"
              value={username}
              onChange={setUsername}
              placeholder="username หรือ name@company.com"
              autoFocus
              autoComplete="username"
            />
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
