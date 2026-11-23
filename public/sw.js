// 外壳缓存：网络优先，3 秒超时或失败时用缓存。/api/ 和跨域（地图瓦片）不处理。
// 改了前端文件就把 VERSION 加 1。
const VERSION = 'v23';
const CACHE = `gta-shell-${VERSION}`;
const SHELL = [
  '/live', '/app.js', '/plan.js', '/push.js', '/style.css', '/manifest.webmanifest',
  '/leaflet/leaflet.js', '/leaflet/leaflet.css',
  '/leaflet/images/marker-icon.png', '/leaflet/images/marker-icon-2x.png', '/leaflet/images/marker-shadow.png',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(async url => {
    const response = await fetch(url);
    if (response.ok && !response.redirected) await c.put(url, response);
  }))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('gta-shell-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // Cache only the live app's shell. Guide HTML, Next assets/RSC, auth and API
  // responses stay on the network; a stale public page must never replace a map.
  if (req.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then(res => { if (res.ok && !res.redirected) cache.put(req, res.clone()); return res; }); // 不缓存登录跳转
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
    try { return await Promise.race([net, timeout]); }
    catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return net; // 没缓存就继续等网络
    }
  })());
});

// ---------- 推送通知 ----------
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'GTA 公交实时', {
    body: d.body || '', tag: d.tag, renotify: true,
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/live' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '/live', self.location.origin);
  // Old notifications and generic reminders used '/'. Keep them in the live
  // app after the SEO homepage takes that URL; preserve any stop/tab query.
  if (target.origin === self.location.origin && target.pathname === '/') target.pathname = '/live';
  const url = target.href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
