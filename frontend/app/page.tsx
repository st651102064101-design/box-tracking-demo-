'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';

/**
 * Auth gate. When signed in, render the legacy app (served verbatim from
 * /legacy.html) in a full-viewport iframe — same-origin, so its own fetches
 * to /api/* and its 'boxtrace_jwt' localStorage read work unchanged. Kept as
 * an iframe rather than a redirect so the address bar stays on "/" instead
 * of switching to "/legacy.html". Otherwise redirect to the login screen.
 */
export default function Home() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (getToken()) {
      setReady(true);
    } else {
      router.replace('/login');
    }
  }, [router]);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f5f5f7]">
        <div className="flex flex-col items-center gap-3 text-ink-2">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink/15 border-t-ink" />
          <p className="text-sm">กำลังโหลด…</p>
        </div>
      </main>
    );
  }

  return (
    <iframe
      src="/legacy.html"
      title="BoxTrace"
      style={{ display: 'block', width: '100vw', height: '100vh', border: 'none' }}
    />
  );
}
