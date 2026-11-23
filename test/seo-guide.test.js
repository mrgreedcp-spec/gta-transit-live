import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSeoGuide, PUBLIC_GUIDE_PATHS, markPrivateResponse, handleLivePage } from '../server/seo-guide.js';

process.env.APP_PASSWORD = 'guide-test-password';
process.env.SEO_GUIDE = '1';
delete process.env.ACCOUNTS;
delete process.env.SESSION_SECRET;
const { handleAuth } = await import('../server/auth.js');

function makeServer(handler) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await handler(req, res, url)) return;
    markPrivateResponse(res, url);
    if (await handleAuth(req, res, url)) return;
    if (await handleLivePage(url, res, async (mappedUrl, response) => {
      assert.equal(mappedUrl.pathname, '/index.html');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Original live map shell</h1>');
    })) return;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('authenticated-only');
  });
}

let directory, guide, server, origin;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'gta-guide-'));
  const files = {
    'index.html': '<!doctype html><html lang="en-CA"><h1>Public transit guide</h1></html>',
    'robots.txt': 'User-agent: *\nDisallow: /api/\n',
    'sitemap.xml': '<urlset><url><loc>https://example.test/</loc></url></urlset>',
    'operators/ttc.html': '<h1>TTC guide</h1>',
    'zh/one-fare.html': '<h1>换乘指南</h1>',
    '_next/static/chunks/public.js': 'console.log("public guide");',
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
  guide = await createSeoGuide({ enabled: true, directory });
  server = makeServer(guide);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});
const get = (p, opts = {}) => fetch(origin + p, { redirect: 'manual', ...opts });

test('flag disabled leaves every request to existing authentication and needs no build', async () => {
  const off = await createSeoGuide({ enabled: false, directory: '/does-not-exist' });
  assert.equal(await off({ method: 'GET' }, {}, new URL('http://localhost/')), false);
});

test('an enabled but missing export fails startup with an actionable error', async () => {
  await assert.rejects(createSeoGuide({ enabled: true, directory: path.join(directory, 'absent') }), /npm run build/);
});

test('anonymous users and bots see identical HTML and metadata endpoints', async () => {
  const human = await get('/');
  const bot = await get('/', { headers: { 'user-agent': 'Googlebot' } });
  assert.equal(human.status, 200);
  assert.equal(bot.status, 200);
  assert.equal(await human.text(), await bot.text());
  for (const p of ['/robots.txt', '/sitemap.xml', '/operators/ttc', '/zh/one-fare']) {
    const result = await get(p);
    assert.equal(result.status, 200, p);
    assert.equal(result.headers.get('set-cookie'), null, p);
  }
});

test('private API, account, admin and live map remain protected; guide POST is not public', async () => {
  for (const p of ['/api/vehicles', '/api/account/favs', '/api/admin/growth', '/api/go/raw/private', '/admin', '/live', '/index.html', '/_next/data/private']) {
    const r = await get(p);
    // Unrecognized Next paths are public 404, never a private handler.
    assert.equal(r.status, p.startsWith('/_next/') ? 404 : 401, p);
    if (!p.startsWith('/_next/')) assert.equal(r.headers.get('x-robots-tag'), 'noindex', p);
    assert.doesNotMatch(await r.text(), /authenticated-only/);
  }
  const post = await get('/fare-calculator', { method: 'POST', body: 'x=1' });
  assert.equal(post.status, 401);
});

test('unknown guide pages return real noindex 404 instead of login or fake content', async () => {
  for (const p of ['/routes/fake-route', '/operators/fake-operator', '/zh/missing', '/sources/deeper', '/_next/private.js']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.match(await r.text(), /Page not found/);
  }
});

test('encoded traversal and encoded separators cannot escape the public export', async () => {
  for (const p of ['/operators/%2f..%2f..%2fserver%2findex.js', '/_next/static/%2e%2e%2f%2e%2e%2f.env', '/zh/%5c..%5cserver', '/_next/static/%00.txt']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
  }
});

test('trailing-slash URLs canonicalize and retain query strings', async () => {
  const r = await get('/operators/ttc/?source=search');
  assert.equal(r.status, 308);
  assert.equal(r.headers.get('location'), '/operators/ttc?source=search');
});

test('legacy notification and campaign links retain original queries on the live map', async () => {
  for (const query of ['?stop=miway%3A0085', '?tab=favs', '?ref=xhs&tab=favs']) {
    const r = await get('/' + query);
    assert.equal(r.status, 307);
    assert.equal(r.headers.get('location'), '/live' + query);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await get('/?utm_source=search')).status, 200);
});

test('static assets have correct MIME, long cache and HEAD semantics', async () => {
  const r = await get('/_next/static/chunks/public.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const head = await get('/operators/ttc', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(await head.text(), '');
});

test('login reaches the live app when the guide is enabled', async () => {
  const r = await get('/login', { method: 'POST', body: 'password=guide-test-password', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/live');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const protectedResult = await get('/api/vehicles', { headers: { cookie } });
  assert.equal(protectedResult.status, 200);
  const map = await get('/live', { headers: { cookie } });
  assert.equal(map.status, 200);
  assert.equal(map.headers.get('x-robots-tag'), 'noindex');
  assert.match(await map.text(), /Original live map shell/);
  const slash = await get('/live/?tab=favs', { headers: { cookie } });
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get('location'), '/live?tab=favs');
});

test('page allowlist contains only deliberate English and Chinese guide paths', () => {
  assert.equal(PUBLIC_GUIDE_PATHS.size, 26);
  assert.ok(PUBLIC_GUIDE_PATHS.has('/zh'));
  assert.ok(PUBLIC_GUIDE_PATHS.has('/zh/routes/pearson-to-union-station'));
  assert.ok(!PUBLIC_GUIDE_PATHS.has('/api/status'));
  assert.ok(!PUBLIC_GUIDE_PATHS.has('/live'));
});

test('disabling the guide keeps the installed PWA live path and original login target', async () => {
  const off = await createSeoGuide({ enabled: false });
  const fallback = makeServer(off);
  await new Promise(resolve => fallback.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fallback.address().port}`;
  const prior = process.env.SEO_GUIDE;
  process.env.SEO_GUIDE = '0';
  try {
    assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 401);
    const login = await fetch(base + '/login', { method: 'POST', body: 'password=guide-test-password', redirect: 'manual' });
    assert.equal(login.headers.get('location'), '/');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const live = await fetch(base + '/live', { headers: { cookie } });
    assert.equal(live.status, 200);
    assert.match(await live.text(), /Original live map shell/);
  } finally {
    process.env.SEO_GUIDE = prior;
    await new Promise(resolve => fallback.close(resolve));
  }
});

test('built export: all 26 approved pages and every referenced local asset are anonymously reachable', async t => {
  const builtDirectory = path.resolve(import.meta.dirname, '..', 'web', 'out');
  try { await access(path.join(builtDirectory, 'index.html')); } catch { return t.skip('Run npm run build to verify the production export.'); }
  const built = makeServer(await createSeoGuide({ enabled: true, directory: builtDirectory }));
  await new Promise(resolve => built.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${built.address().port}`;
  try {
    const assets = new Set();
    for (const p of PUBLIC_GUIDE_PATHS) {
      const response = await fetch(base + p, { redirect: 'manual' });
      assert.equal(response.status, 200, p);
      const html = await response.text();
      assert.match(html, /<h1\b/, p);
      assert.match(html, /rel="canonical"/, p);
      for (const match of html.matchAll(/(?:src|href)="(\/(?:_next\/static\/[^"?#]+|guide-[^"?#]+\.svg))"/g)) assets.add(match[1]);
    }
    assert.ok(assets.size > 2);
    for (const asset of assets) assert.equal((await fetch(base + asset, { redirect: 'manual' })).status, 200, asset);
    const source = await readFile(path.join(builtDirectory, 'sitemap.xml'), 'utf8');
    const entries = [...source.matchAll(/<loc>([^<]+)<\/loc>/g)].map(x => new URL(x[1]).pathname);
    assert.deepEqual(new Set(entries), PUBLIC_GUIDE_PATHS);
  } finally { await new Promise(resolve => built.close(resolve)); }
});
