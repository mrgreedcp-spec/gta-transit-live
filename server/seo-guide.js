// Only the generated, public guide is exposed before authentication. The existing
// API, account pages and live map continue through handleAuth in index.js.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const GUIDE_PAGES = [
  '', 'fare-calculator', 'one-fare', 'operators', 'operators/ttc',
  'operators/miway', 'operators/go-transit', 'routes',
  'routes/square-one-to-union-station', 'routes/pearson-to-union-station',
  'routes/kipling-to-square-one', 'sources', 'privacy',
];
export const PUBLIC_GUIDE_PATHS = new Set([
  ...GUIDE_PAGES.map(p => p ? `/${p}` : '/'),
  ...GUIDE_PAGES.map(p => p ? `/zh/${p}` : '/zh'),
]);
const FILES = new Set(['/robots.txt', '/sitemap.xml', '/guide-icon.svg', '/guide-social.svg']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const DEFAULT_DIRECTORY = path.resolve(import.meta.dirname, '..', 'web', 'out');

// Applied before handleAuth so even a redirect/401 on a private page is noindex.
export function markPrivateResponse(res, url) {
  if (/^\/(?:live|login|register|logout|admin|api)(?:\/|$)/.test(url.pathname) || ['/index.html', '/admin.js'].includes(url.pathname)) {
    res.setHeader('x-robots-tag', 'noindex');
  }
}

// The caller MUST run handleAuth first. This alias also works with SEO_GUIDE=0,
// keeping an installed PWA usable when the public guide is rolled back.
export async function handleLivePage(url, res, serveFile) {
  if (url.pathname === '/live/') {
    res.writeHead(308, { location: `/live${url.search}` }); res.end(); return true;
  }
  if (url.pathname !== '/live') return false;
  await serveFile(new URL('/index.html', url), res);
  return true;
}

function belongsToGuide(p) {
  return p === '/' || FILES.has(p) || /^\/(?:zh|fare-calculator|one-fare|operators|routes|sources|privacy)(?:\/|$)/.test(p) || p.startsWith('/_next/');
}

function end(req, res, status, body, headers = {}) {
  let bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { 'x-content-type-options': 'nosniff', ...headers };
  if (bytes.length > 1024 && /\bgzip\b/.test(req.headers?.['accept-encoding'] || '') && /text|javascript|json|xml|svg/.test(h['content-type'] || '')) {
    bytes = zlib.gzipSync(bytes);
    h['content-encoding'] = 'gzip';
    h.vary = 'Accept-Encoding';
  }
  h['content-length'] = String(bytes.length);
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

function missing(req, res) {
  end(req, res, 404, '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found | GTA Transit Live</title><meta name="robots" content="noindex"><body><main><h1>Page not found</h1><p>This transit guide is not available.</p><p><a href="/">GTA Transit Live home</a></p></main></body></html>', {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
  });
}

/**
 * Build once at startup. No database, network or user-store calls are made here.
 * When enabled, an incomplete build is a deployment error, not a silent login page.
 */
export async function createSeoGuide({ enabled = process.env.SEO_GUIDE === '1', directory = DEFAULT_DIRECTORY } = {}) {
  if (!enabled) return async () => false;
  const root = path.resolve(directory);
  for (const file of ['index.html', 'robots.txt', 'sitemap.xml']) {
    try {
      if (!(await stat(path.join(root, file))).isFile()) throw new Error('not a file');
    } catch {
      throw new Error(`SEO_GUIDE=1 requires the built guide (${file} missing). Run npm run build before starting the server.`);
    }
  }

  return async function handleSeoGuide(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const p = url.pathname;
    if (!belongsToGuide(p)) return false;

    // Existing notification and campaign links still enter the authenticated map.
    if (p === '/' && ['stop', 'tab', 'ref'].some(key => url.searchParams.has(key))) {
      end(req, res, 307, '', { location: `/live${url.search}`, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
      return true;
    }

    // Refuse encoded separators/dot segments. Never let export-path decoding turn
    // a public asset request into access to a sibling private directory.
    if (p.includes('%') || p.includes('\\') || p.split('/').some(part => part === '.' || part === '..')) {
      missing(req, res); return true;
    }

    const normalized = p.length > 1 ? p.replace(/\/+$/, '') : p;
    if (p !== normalized && PUBLIC_GUIDE_PATHS.has(normalized)) {
      end(req, res, 308, '', { location: `${normalized}${url.search}`, 'cache-control': 'public, max-age=3600' });
      return true;
    }
    let relative;
    if (PUBLIC_GUIDE_PATHS.has(p)) relative = p === '/' ? 'index.html' : `${p.slice(1)}.html`;
    else if (FILES.has(p)) relative = p.slice(1);
    else if (p.startsWith('/_next/static/') && !p.includes('//')) relative = p.slice(1);
    else { missing(req, res); return true; }

    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { missing(req, res); return true; }
    let raw;
    try { raw = await readFile(file); } catch { missing(req, res); return true; }
    end(req, res, 200, raw, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': p.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    });
    return true;
  };
}
