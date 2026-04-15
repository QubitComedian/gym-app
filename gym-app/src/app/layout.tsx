import type { Metadata, Viewport } from 'next';
import './globals.css';
import Nav from '@/components/Nav';
import ToastProvider from '@/components/ui/Toast';
import PendingProposalsWatcher from '@/components/PendingProposalsWatcher';

export const metadata: Metadata = {
  title: 'Gym',
  description: 'Your training log + AI-adaptive program',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Gym' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  userScalable: false,
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">
        <ToastProvider>
          <PendingProposalsWatcher />
          {children}
          <Nav />
        </ToastProvider>
      </body>
    </html>
  );
}
