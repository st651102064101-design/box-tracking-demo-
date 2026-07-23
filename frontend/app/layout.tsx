import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BoxTrace — ประตูสแกน · Returnable Asset Tracking',
  description: 'RFID Gate / Returnable Asset Tracking (WMS)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
