'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';

/**
 * Auth gate. When signed in, hand the whole viewport to the legacy app
 * (served verbatim from /legacy.html) so the UI is 100% identical to the
 * original. Otherwise redirect to the login screen.
 */
export default function Home() {
  const router = useRouter();
  const [msg, setMsg] = useState('กำลังโหลด…');

  useEffect(() => {
    if (getToken()) {
      setMsg('กำลังเปิดระบบ…');
      window.location.replace('/legacy.html');
    } else {
      router.replace('/login');
    }
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f5f7]">
      <div className="flex flex-col items-center gap-3 text-ink-2">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink/15 border-t-ink" />
        <p className="text-sm">{msg}</p>
      </div>
    </main>
  );
}
