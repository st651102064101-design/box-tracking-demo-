import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Smart Tracking — ระบบติดตามสินทรัพย์หมุนเวียน',
  description: 'ระบบประตู RFID และติดตามสินทรัพย์หมุนเวียน',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
