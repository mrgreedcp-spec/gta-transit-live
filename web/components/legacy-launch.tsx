'use client';
import { useEffect } from 'react';

export function LegacyLaunch() {
  useEffect(() => {
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
    if (location.pathname === '/' && (iosStandalone || window.matchMedia('(display-mode: standalone)').matches)) {
      location.replace(`/live${location.search}${location.hash}`);
    }
  }, []);
  return null;
}
