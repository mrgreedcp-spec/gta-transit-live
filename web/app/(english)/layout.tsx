import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import '../globals.css';

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a665d' };
export default function EnglishLayout({ children }: { children: ReactNode }) {
  return <html lang="en-CA"><body>{children}</body></html>;
}
