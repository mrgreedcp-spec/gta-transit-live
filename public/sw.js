// 外壳缓存：网络优先，3 秒超时或失败时用缓存。/api/ 和跨域（地图瓦片）不处理。
// 改了前端文件就把 VERSION 加 1。
const VERSION = 'v8';
const CACHE = `gta-shell-${VERSION}`;
const SHELL = [
  '/', '/app.js', '/plan.js', '/push.js', '/style.css', '/manifest.webmanifest',
  '/leaflet/leaflet.js', '/leaflet/leaflet.css',
  '/leaflet/images/marker-icon.png', '/leaflet/images/marker-icon-2x.png', '/leaflet/images/marker-shadow.png',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('gta-shell-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || /^\/(api\/|login|logout)/.test(url.pathname)) return;
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
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
