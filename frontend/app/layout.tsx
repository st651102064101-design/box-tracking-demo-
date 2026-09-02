import type { Metadata } from 'next';
import { I18nProvider } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'Smart Tracking',
  description: 'Returnable Asset Tracking',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  );
}
