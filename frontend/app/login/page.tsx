'use client';

import { useState } from 'react';
import { login, register, setToken } from '@/lib/api';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res =
        mode === 'login'
          ? await login(username.trim(), password)
          : await register(username.trim(), password, name.trim() || username.trim());
      setToken(res.token);
      window.location.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f5f7] px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-[0_24px_70px_rgba(0,0,0,.10)]">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-xl font-black text-white">B</div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-ink">BoxTrace</h1>
            <p className="-mt-0.5 text-xs text-ink-2/70">Returnable Asset Tracking</p>
          </div>
        </div>

        <h2 className="mb-4 text-xl font-bold tracking-tight text-ink">
          {mode === 'login' ? 'เข้าสู่ระบบ' : 'สร้างบัญชีใหม่'}
        </h2>

        <form onSubmit={submit} className="space-y-3">
          {mode === 'register' && (
            <Field label="ชื่อ-นามสกุล" value={name} onChange={setName} placeholder="เช่น สมชาย ใจดี" />
          )}
          <Field label="ชื่อผู้ใช้" value={username} onChange={setUsername} placeholder="username" autoFocus />
          <Field label="รหัสผ่าน" value={password} onChange={setPassword} type="password" placeholder="••••••" />

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-ink py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'กำลังดำเนินการ…' : mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครและเข้าสู่ระบบ'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
          className="mt-4 w-full text-center text-sm text-ink-2/70 hover:text-ink"
        >
          {mode === 'login' ? 'ยังไม่มีบัญชี? สมัครใหม่' : 'มีบัญชีแล้ว? เข้าสู่ระบบ'}
        </button>

        <p className="mt-6 text-center text-xs text-ink-2/50">
          บัญชีเริ่มต้น (หลัง <code>npm run db:seed</code>): <b>admin / admin123</b>
        </p>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
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
        className="w-full rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2.5 text-sm text-ink outline-none transition focus:border-black/30 focus:bg-white"
      />
    </label>
  );
}
