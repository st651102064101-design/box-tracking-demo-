'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, clearToken, getBranding, getToken, me, type SystemBranding } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/**
 * Auth gate. When signed in, render the legacy app (served verbatim from
 * /legacy.html) in a full-viewport iframe — same-origin, so its own fetches
 * to /api/* and its 'smarttrace_jwt' localStorage read work unchanged. Kept as
 * an iframe rather than a redirect so the address bar stays on "/" instead
 * of switching to "/legacy.html". Otherwise redirect to the login screen.
 */
export default function Home() {
  const router = useRouter();
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const [loadingTab, setLoadingTab] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    me()
      .then((session) => {
        if (session.user.firstSetupRequired) router.replace('/onboarding');
        else setReady(true);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) clearToken();
        router.replace('/login');
      });
  }, [router]);

  useEffect(() => {
    /* legacy.html runs in an iframe. Notification permission belongs to the
       top-level document, so accept the iframe's user-initiated request here. */
    const onNotificationRequest = (event: MessageEvent) => {
      const frame = document.querySelector('iframe');
      if (event.source !== frame?.contentWindow || event.data?.type !== 'boxtrace-request-notification') return;
      if (!('Notification' in window) || Notification.permission !== 'default') return;
      Notification.requestPermission().catch(() => undefined);
    };
    window.addEventListener('message', onNotificationRequest);
    return () => window.removeEventListener('message', onNotificationRequest);
  }, []);

  useEffect(() => {
    const onAppReady = (event: MessageEvent) => {
      const frame = document.querySelector('iframe');
      if (event.source !== frame?.contentWindow) return;
      if (event.data?.type === 'smarttrace-loading-tab') setLoadingTab(String(event.data.tab || 'overview'));
      if (event.data?.type === 'smarttrace-ready') setAppReady(true);
    };
    window.addEventListener('message', onAppReady);
    return () => window.removeEventListener('message', onAppReady);
  }, []);

  useEffect(() => {
    if (!ready || appReady) return;
    /* A broken legacy boot must not mask the working application forever. */
    const timer = window.setTimeout(() => setAppReady(true), 5000);
    return () => window.clearTimeout(timer);
  }, [ready, appReady]);

  useEffect(() => {
    const applyTabBranding = (branding: SystemBranding) => {
      const name = branding.systemName?.trim() || 'Smart Tracking';
      document.title = `${name} — ระบบติดตามสินทรัพย์หมุนเวียน`;
      /* Keep the browser tab icon in sync with the same Branding record that
         drives the legacy application. Change the existing link's href rather
         than removing a node owned by Next's metadata tree. */
      let favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      if (!favicon) {
        favicon = document.createElement('link');
        favicon.rel = 'icon';
        document.head.appendChild(favicon);
      }
      favicon.href = branding.logoData || '/api/branding/favicon';
    };
    const onBranding = (event: MessageEvent) => {
      const frame = document.querySelector('iframe');
      if (event.source !== frame?.contentWindow || event.data?.type !== 'boxtrace-branding') return;
      applyTabBranding(event.data.branding as SystemBranding);
    };
    window.addEventListener('message', onBranding);
    getBranding().then(applyTabBranding).catch(() => undefined);
    return () => window.removeEventListener('message', onBranding);
  }, []);

  return (
    <main className="app-shell">
      {!appReady && <AppSkeleton tab={loadingTab} />}
      {ready && <iframe
        src="/legacy.html"
        title={t('app.frameTitle')}
        allow="fullscreen; pointer-lock"
        allowFullScreen
        onLoad={() => setAppReady(true)}
        className={`app-frame${appReady ? ' is-ready' : ''}`}
      />}
    </main>
  );
}

/* Which rough shape to show depends on the tab the app is about to land on
   — a fixed "5 cards + table" skeleton only looks right for Overview, and
   was visibly wrong (mismatched layout) for every other tab. legacy.html's
   switchTab() mirrors the active tab into this same localStorage key
   (same-origin, synchronous — the DB-backed uiPrefGet('tab') the app
   actually restores from is async and would be too slow to wait on here)
   so this can guess before the iframe even starts loading. */
type SkeletonVariant = 'overview' | 'form' | 'table' | 'setup';
const TAB_VARIANT: Record<string, SkeletonVariant> = {
  overview: 'overview',
  gateout: 'form',
  gatein: 'form',
  inventory: 'table',
  track: 'table',
  setup: 'setup',
};

function getSkeletonVariant(): SkeletonVariant {
  try {
    return TAB_VARIANT[localStorage.getItem('smarttrace_last_tab') || ''] ?? 'overview';
  } catch {
    return 'overview';
  }
}

function AppSkeleton({ tab }: { tab: string | null }) {
  /* Default to 'overview' — matches what the server renders (no localStorage
     there) — then correct it right after mount. Reading localStorage during
     render itself would make the client's first render disagree with the
     server's, which React treats as a hydration error since this is real
     JSX structure, not a raw DOM write like the theme-sync script in
     layout.tsx (that one runs before React ever touches the tree). */
  const [variant, setVariant] = useState<SkeletonVariant>('overview');
  useEffect(() => setVariant(tab ? (TAB_VARIANT[tab] ?? 'overview') : getSkeletonVariant()), [tab]);
  return <div className="app-skeleton" role="status" aria-label="กำลังเตรียมข้อมูลระบบ">
    <header className="skeleton-header"><div className="skeleton-line skeleton-brand"/><div className="skeleton-nav">{Array.from({length:6},(_,i)=><div className="skeleton-line skeleton-nav-item" key={i}/>)}</div><div className="skeleton-circle"/></header>
    <section className="skeleton-content">
      <div className="skeleton-line skeleton-eyebrow"/><div className="skeleton-line skeleton-title"/><div className="skeleton-line skeleton-subtitle"/>
      {variant === 'overview' && <>
        <div className="skeleton-grid">{Array.from({length:5},(_,i)=><div className="skeleton-card" key={i}><div className="skeleton-circle skeleton-card-icon"/><div className="skeleton-line skeleton-card-value"/><div className="skeleton-line skeleton-card-label"/></div>)}</div>
        <div className="skeleton-line skeleton-section-title"/>
        <div className="skeleton-table"><div className="skeleton-table-head"/>{Array.from({length:5},(_,i)=><div className="skeleton-table-row" key={i}/>)}</div>
      </>}
      {variant === 'form' && <div className="skeleton-form">{Array.from({length:4},(_,i)=><div className="skeleton-line skeleton-form-field" key={i}/>)}</div>}
      {variant === 'table' && <>
        <div className="skeleton-line skeleton-toolbar"/>
        <div className="skeleton-table"><div className="skeleton-table-head"/>{Array.from({length:7},(_,i)=><div className="skeleton-table-row" key={i}/>)}</div>
      </>}
      {variant === 'setup' && <>
        <div className="skeleton-pills">{Array.from({length:4},(_,i)=><div className="skeleton-line skeleton-pill" key={i}/>)}</div>
        <div className="skeleton-table"><div className="skeleton-table-head"/>{Array.from({length:5},(_,i)=><div className="skeleton-table-row" key={i}/>)}</div>
      </>}
    </section>
    <span className="sr-only">กำลังเตรียมข้อมูลระบบ</span>
  </div>;
}
