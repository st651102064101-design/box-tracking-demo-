'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Locale = 'th' | 'en';

const th = {
  'language.th': 'ไทย',
  'language.en': 'English',
  'language.switch': 'เปลี่ยนภาษา',
  'app.loading': 'กำลังโหลด…',
  'app.frameTitle': 'Smart Tracking',
  'app.metaTitle': 'Smart Tracking — ระบบติดตามสินทรัพย์หมุนเวียน',
  'app.metaDescription': 'ระบบประตู RFID และติดตามสินทรัพย์หมุนเวียน',
  'login.subtitleFallback': 'WMS · เฟส 1 · ระบบติดตามสินทรัพย์หมุนเวียน',
  'login.validation.usernameRequired': 'กรุณากรอกชื่อผู้ใช้หรืออีเมล',
  'login.validation.passwordRequired': 'กรุณากรอกรหัสผ่าน',
  'login.validation.otpLength': 'กรุณากรอกรหัส OTP ให้ครบ 6 หลัก',
  'password.validation.minLength': 'รหัสผ่านต้องมีอย่างน้อย 10 ตัวอักษร',
  'password.validation.lowercase': 'ต้องมีตัวพิมพ์เล็ก',
  'password.validation.uppercase': 'ต้องมีตัวพิมพ์ใหญ่',
  'password.validation.number': 'ต้องมีตัวเลข',
  'password.validation.special': 'ต้องมีอักขระพิเศษ',
  'login.otp.sent': 'ส่งรหัส OTP ไปที่ {destination} แล้ว — กรอกรหัส 6 หลักด้านล่าง (มีอายุ 5 นาที)',
  'login.otp.generic': 'หากมีบัญชีนี้อยู่ในระบบ จะมีอีเมลส่งรหัส OTP ไปให้ — กรอกรหัส 6 หลักด้านล่าง',
  'common.actionFailed': 'ดำเนินการไม่สำเร็จ',
  'login.title.signIn': 'เข้าสู่ระบบ',
  'login.title.forgot': 'ลืมรหัสผ่าน',
  'login.title.reset': 'ตั้งรหัสผ่านใหม่',
  'login.submit.signIn': 'เข้าสู่ระบบ',
  'login.submit.sendOtp': 'ส่งรหัส OTP ทางอีเมล',
  'login.submit.reset': 'ตั้งรหัสผ่านใหม่และเข้าสู่ระบบ',
  'login.lastSignedInAs': 'เข้าสู่ระบบล่าสุดในชื่อ',
  'login.notMe': 'ไม่ใช่ฉัน',
  'login.username.label': 'ชื่อผู้ใช้ หรือ อีเมล',
  'login.username.placeholder': 'ชื่อผู้ใช้ หรือ อีเมลองค์กร',
  'login.quickAgain': 'กลับไปเข้าสู่ระบบด้วย “{username}”',
  'login.account': 'บัญชี:',
  'login.otp.label': 'รหัส OTP (6 หลัก)',
  'login.password.newLabel': 'รหัสผ่านใหม่',
  'login.password.newPlaceholder': '10+ ตัว: พิมพ์ใหญ่ พิมพ์เล็ก ตัวเลข และสัญลักษณ์',
  'login.password.label': 'รหัสผ่าน',
  'common.processing': 'กำลังดำเนินการ…',
  'login.forgotQuestion': 'ลืมรหัสผ่าน?',
  'login.back': 'กลับไปเข้าสู่ระบบ',
  'login.devOnly': 'สำหรับการพัฒนาเท่านั้น — บัญชีเริ่มต้นตั้งจาก SEED_ADMIN_* ในตัวแปรสภาพแวดล้อม (ดู npm run db:seed)',
  'setup.validation.required': 'จำเป็นต้องกรอก',
  'setup.validation.email': 'อีเมลไม่ถูกต้อง',
  'setup.validation.username': 'ใช้ a-z, 0-9, . _ - อย่างน้อย 3 ตัว',
  'setup.validation.phone': 'เบอร์โทรศัพท์ไม่ถูกต้อง',
  'setup.validation.passwordMin': 'อย่างน้อย 10 ตัวอักษร',
  'setup.error': 'ตั้งค่าระบบไม่สำเร็จ',
  'setup.firstTime': 'ตั้งค่าครั้งแรก',
  'setup.superAdmin': 'EMP-001 · ผู้ดูแลระบบสูงสุด',
  'setup.title': 'ตั้งค่าผู้ดูแลระบบคนแรก',
  'setup.description': 'บัญชี Bootstrap นี้จะถูกเปลี่ยนเป็นบัญชีจริงของ EMP-001 โดยไม่สร้างบัญชีซ้ำ เมื่อเสร็จแล้วรหัสผ่านเริ่มต้นจะใช้ไม่ได้ทันที',
  'setup.field.name': 'ชื่อ–นามสกุล',
  'setup.field.email': 'อีเมลองค์กร',
  'setup.field.username': 'Username ใหม่',
  'setup.field.password': 'Password ใหม่',
  'setup.field.phone': 'เบอร์โทรศัพท์',
  'setup.field.position': 'ตำแหน่ง',
  'setup.field.department': 'แผนก',
  'setup.field.warehouse': 'คลังหลัก',
  'setup.field.warehousePlaceholder': 'เช่น WH-001 หรือ คลังหลัก',
  'setup.passwordReady': '✓ รหัสผ่านผ่านนโยบาย',
  'setup.passwordPolicy': 'รหัสผ่าน 10+ ตัว พร้อมตัวพิมพ์ใหญ่ พิมพ์เล็ก ตัวเลข และอักขระพิเศษ',
  'setup.creating': 'กำลังสร้าง EMP-001 และเปิดใช้งานบัญชี…',
  'setup.start': 'เริ่มใช้งานระบบ',
  'setup.auditNotice': 'ระบบจะบันทึกทุกขั้นตอนใน Audit Log และออก session ใหม่ให้โดยอัตโนมัติ',
} as const;

const en: Record<keyof typeof th, string> = {
  'language.th': 'TH',
  'language.en': 'EN',
  'language.switch': 'Switch language',
  'app.loading': 'Loading…',
  'app.frameTitle': 'Smart Tracking',
  'app.metaTitle': 'Smart Tracking — Returnable Asset Tracking',
  'app.metaDescription': 'RFID gate and returnable asset tracking system',
  'login.subtitleFallback': 'WMS · Phase 1 · Returnable Asset Tracking',
  'login.validation.usernameRequired': 'Enter your username or email',
  'login.validation.passwordRequired': 'Enter your password',
  'login.validation.otpLength': 'Enter the complete 6-digit OTP',
  'password.validation.minLength': 'Password must be at least 10 characters',
  'password.validation.lowercase': 'Include a lowercase letter',
  'password.validation.uppercase': 'Include an uppercase letter',
  'password.validation.number': 'Include a number',
  'password.validation.special': 'Include a special character',
  'login.otp.sent': 'OTP sent to {destination}. Enter the 6-digit code below (valid for 5 minutes).',
  'login.otp.generic': 'If this account exists, an OTP will be emailed to it. Enter the 6-digit code below.',
  'common.actionFailed': 'The operation failed',
  'login.title.signIn': 'Sign in',
  'login.title.forgot': 'Forgot password',
  'login.title.reset': 'Set a new password',
  'login.submit.signIn': 'Sign in',
  'login.submit.sendOtp': 'Email OTP',
  'login.submit.reset': 'Set password and sign in',
  'login.lastSignedInAs': 'Last signed in as',
  'login.notMe': 'Not me',
  'login.username.label': 'Username or email',
  'login.username.placeholder': 'Username or work email',
  'login.quickAgain': 'Sign in again as “{username}”',
  'login.account': 'Account:',
  'login.otp.label': 'OTP (6 digits)',
  'login.password.newLabel': 'New password',
  'login.password.newPlaceholder': '10+ characters with uppercase, lowercase, number, and symbol',
  'login.password.label': 'Password',
  'common.processing': 'Processing…',
  'login.forgotQuestion': 'Forgot password?',
  'login.back': 'Back to sign in',
  'login.devOnly': 'Development only — the initial account comes from SEED_ADMIN_* environment variables (see npm run db:seed)',
  'setup.validation.required': 'Required',
  'setup.validation.email': 'Invalid email address',
  'setup.validation.username': 'Use a-z, 0-9, . _ - with at least 3 characters',
  'setup.validation.phone': 'Invalid phone number',
  'setup.validation.passwordMin': 'At least 10 characters',
  'setup.error': 'System setup failed',
  'setup.firstTime': 'First-time setup',
  'setup.superAdmin': 'EMP-001 · Super Admin',
  'setup.title': 'Set up the first administrator',
  'setup.description': 'This bootstrap account will become the real EMP-001 account without creating a duplicate. The initial password will stop working immediately after setup.',
  'setup.field.name': 'Full name',
  'setup.field.email': 'Work email',
  'setup.field.username': 'New username',
  'setup.field.password': 'New password',
  'setup.field.phone': 'Phone number',
  'setup.field.position': 'Position',
  'setup.field.department': 'Department',
  'setup.field.warehouse': 'Primary warehouse',
  'setup.field.warehousePlaceholder': 'e.g. WH-001 or Main warehouse',
  'setup.passwordReady': '✓ Password meets the policy',
  'setup.passwordPolicy': 'Use 10+ characters with uppercase, lowercase, a number, and a special character',
  'setup.creating': 'Creating EMP-001 and activating the account…',
  'setup.start': 'Start using the system',
  'setup.auditNotice': 'Every setup step is recorded in the Audit Log and a new session is issued automatically.',
};

export type TranslationKey = keyof typeof th;
type Params = Record<string, string | number>;
type I18nContextValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: TranslationKey, params?: Params) => string };

const I18nContext = createContext<I18nContextValue | null>(null);
const STORAGE_KEY = 'smarttrace_lang';

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('th');

  const applyLocale = useCallback((next: Locale, persist = true) => {
    setLocaleState(next);
    document.documentElement.lang = next;
    document.documentElement.dataset.lang = next;
    if (persist) window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    applyLocale(saved === 'en' ? 'en' : 'th', false);
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) applyLocale(event.newValue === 'en' ? 'en' : 'th', false);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [applyLocale]);

  useEffect(() => {
    const dictionary = locale === 'en' ? en : th;
    document.title = dictionary['app.metaTitle'];
    document.querySelector('meta[name="description"]')?.setAttribute('content', dictionary['app.metaDescription']);
  }, [locale]);

  const t = useCallback((key: TranslationKey, params?: Params) => {
    let value = (locale === 'en' ? en[key] : th[key]) || th[key] || key;
    if (params) Object.entries(params).forEach(([name, replacement]) => { value = value.replaceAll(`{${name}}`, String(replacement)); });
    return value;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale: (next: Locale) => applyLocale(next), t }), [applyLocale, locale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="inline-flex rounded-full border border-black/10 bg-white/85 p-1 text-xs font-semibold shadow-sm backdrop-blur" aria-label={t('language.switch')}>
      {(['th', 'en'] as Locale[]).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setLocale(option)}
          aria-pressed={locale === option}
          className={`rounded-full px-3 py-1.5 transition ${option === 'en' ? 'text-ink hover:text-ink' : locale === option ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink'}`}
        >
          {t(`language.${option}` as TranslationKey)}
        </button>
      ))}
    </div>
  );
}
