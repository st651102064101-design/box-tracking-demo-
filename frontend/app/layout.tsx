import type { Metadata } from 'next';
import { I18nProvider } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'Smart Tracking',
  description: 'Returnable Asset Tracking',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" suppressHydrationWarning>
      <head>
        {/* Same stored choice as legacy.html: ตามระบบ / สว่าง / มืด. Runs before paint so
            the login page never flashes the wrong theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function apply(){try{var m=localStorage.getItem('smarttrace_theme');var d=window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches;var t=(m==='light'||m==='dark')?m:(d?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}}apply();if(window.matchMedia){var q=window.matchMedia('(prefers-color-scheme:dark)');(q.addEventListener?q.addEventListener.bind(q,'change'):q.addListener.bind(q))(apply);}})();`,
          }}
        />
      </head>
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  );
}
