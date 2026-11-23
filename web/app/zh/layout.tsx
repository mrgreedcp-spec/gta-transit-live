import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import '../globals.css';

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a665d' };
export default function ChineseLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-Hans"><body>{children}</body></html>;
}
