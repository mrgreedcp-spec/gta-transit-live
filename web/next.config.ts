import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  trailingSlash: false,
  poweredByHeader: false,
  images: { unoptimized: true },
  reactStrictMode: true,
  experimental: { cpus: 1 },
  turbopack: { root: process.cwd() },
};
export default config;
