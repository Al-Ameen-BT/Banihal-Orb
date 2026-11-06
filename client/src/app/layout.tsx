import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import Providers from './providers';
import CookieBanner from '@/components/CookieBanner';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'BanihalOrb',
  description: 'Multi-tenant security operations & client management for managed security service providers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${mono.variable}`}>
      <body className="font-sans antialiased bg-[var(--canvas)] text-[var(--ink)]">
        <Providers>
          {children}
        </Providers>
        <CookieBanner />
      </body>
    </html>
  );
}
