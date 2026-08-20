'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  completeFirstSetup,
  getBranding,
  getToken,
  me,
  setToken,
  type FirstSetupInput,
  type SystemBranding,
} from '@/lib/api';

type Key = keyof FirstSetupInput;
const EMPTY: FirstSetupInput = {
  name: '', email: '', username: '', password: '', phone: '',
  position: '', department: '', warehouse: '',
};

function validate(key: Key, value: string): string {
  const clean = value.trim();
  if (!clean) return 'จำเป็นต้องกรอก';
  if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return 'อีเมลไม่ถูกต้อง';
  if (key === 'username' && !/^[A-Za-z0-9_.-]{3,64}$/.test(clean)) return 'ใช้ a-z, 0-9, . _ - อย่างน้อย 3 ตัว';
  if (key === 'phone' && clean.length < 9) return 'เบอร์โทรศัพท์ไม่ถูกต้อง';
  if (key === 'password') {
    if (value.length < 10) return 'อย่างน้อย 10 ตัวอักษร';
    if (!/[a-z]/.test(value)) return 'ต้องมีตัวพิมพ์เล็ก';
    if (!/[A-Z]/.test(value)) return 'ต้องมีตัวพิมพ์ใหญ่';
    if (!/\d/.test(value)) return 'ต้องมีตัวเลข';
    if (!/[^A-Za-z0-9]/.test(value)) return 'ต้องมีอักขระพิเศษ';
  }
  return '';
}

export default function OnboardingPage() {
  const router = useRouter();
  const [branding, setBranding] = useState<SystemBranding>({ systemName: 'Smart Tracking', subtitle: '', logoData: null });
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const passwordReady = useMemo(() => !validate('password', form.password), [form.password]);

  useEffect(() => {
    getBranding().then(setBranding).catch(() => undefined);
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    me().then((x) => {
      if (!x.user.firstSetupRequired) router.replace('/');
    }).catch(() => router.replace('/login'));
  }, [router]);

  function change(key: Key, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: validate(key, value) || undefined }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = Object.fromEntries(
      (Object.keys(form) as Key[])
        .map((key) => [key, validate(key, form[key])])
        .filter(([, value]) => value),
    ) as Partial<Record<Key, string>>;
    setErrors(next);
    if (Object.keys(next).length) {
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await completeFirstSetup(form);
      setToken(result.token);
      window.localStorage.setItem('st_last_login_user', result.user.username);
      window.location.replace('/');
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.errors).length) {
        setErrors((current) => ({ ...current, ...err.errors }));
      }
      setMessage(err instanceof Error ? err.message : 'ตั้งค่าระบบไม่สำเร็จ');
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f5f5f7] px-4 py-8 sm:py-14">
      <section className="mx-auto w-full max-w-3xl overflow-hidden rounded-[28px] bg-white shadow-[0_28px_90px_rgba(0,0,0,.12)]">
        <header className="border-b border-black/10 bg-ink px-6 py-7 text-white sm:px-9">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center overflow-hidden rounded-xl bg-white/10 text-lg font-bold">
              {branding.logoData ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={branding.logoData} alt="" className="h-full w-full object-cover" />
              ) : branding.systemName.charAt(0)}
            </div>
            <div><p className="font-semibold">{branding.systemName}</p><p className="text-xs text-white/60">ตั้งค่าครั้งแรก</p></div>
          </div>
          <span className="rounded-full bg-[#a8f931] px-3 py-1 text-xs font-bold text-[#243900]">EMP-001 · ผู้ดูแลระบบสูงสุด</span>
          <h1 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">ตั้งค่าผู้ดูแลระบบคนแรก</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-white/65">บัญชี Bootstrap นี้จะถูกเปลี่ยนเป็นบัญชีจริงของ EMP-001 โดยไม่สร้างบัญชีซ้ำ เมื่อเสร็จแล้วรหัสผ่านเริ่มต้นจะใช้ไม่ได้ทันที</p>
        </header>

        <form onSubmit={submit} className="p-6 sm:p-9">
          <div className="grid gap-4 sm:grid-cols-2">
            <SetupField label="ชื่อ–นามสกุล" value={form.name} error={errors.name} onChange={(v) => change('name', v)} autoComplete="name" />
            <SetupField label="อีเมลองค์กร" value={form.email} error={errors.email} onChange={(v) => change('email', v)} type="email" autoComplete="email" />
            <SetupField label="Username ใหม่" value={form.username} error={errors.username} onChange={(v) => change('username', v)} autoComplete="username" />
            <SetupField label="Password ใหม่" value={form.password} error={errors.password} onChange={(v) => change('password', v)} type="password" autoComplete="new-password" />
            <SetupField label="เบอร์โทรศัพท์" value={form.phone} error={errors.phone} onChange={(v) => change('phone', v)} type="tel" autoComplete="tel" />
            <SetupField label="ตำแหน่ง" value={form.position} error={errors.position} onChange={(v) => change('position', v)} />
            <SetupField label="แผนก" value={form.department} error={errors.department} onChange={(v) => change('department', v)} />
            <SetupField label="คลังหลัก" value={form.warehouse} error={errors.warehouse} onChange={(v) => change('warehouse', v)} placeholder="เช่น WH-001 หรือ คลังหลัก" />
          </div>
          <p className={`mt-3 text-xs ${passwordReady ? 'text-emerald-700' : 'text-ink-2/60'}`}>
            {passwordReady ? '✓ รหัสผ่านผ่านนโยบาย' : 'รหัสผ่าน 10+ ตัว พร้อมตัวพิมพ์ใหญ่ พิมพ์เล็ก ตัวเลข และอักขระพิเศษ'}
          </p>
          {message && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{message}</p>}
          <button type="submit" disabled={busy} className="mt-6 w-full rounded-xl bg-[#a8f931] py-3.5 text-sm font-bold text-[#243900] transition hover:brightness-95 disabled:opacity-50">
            {busy ? 'กำลังสร้าง EMP-001 และเปิดใช้งานบัญชี…' : 'เริ่มใช้งานระบบ'}
          </button>
          <p className="mt-3 text-center text-xs text-ink-2/55">ระบบจะบันทึกทุกขั้นตอนใน Audit Log และออก session ใหม่ให้โดยอัตโนมัติ</p>
        </form>
      </section>
    </main>
  );
}

function SetupField({ label, value, error, onChange, type = 'text', autoComplete, placeholder }: {
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
}) {
  const id = `setup-${label}`;
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1.5 block text-xs font-semibold text-ink-2/70">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-xl border bg-black/[0.02] px-3.5 py-3 text-sm text-ink outline-none transition focus:bg-white ${error ? 'border-red-500 ring-2 ring-red-500/10' : 'border-black/10 focus:border-black/30'}`}
      />
      {error && <span role="alert" className="mt-1 block text-xs font-medium text-red-600">{error}</span>}
    </label>
  );
}
