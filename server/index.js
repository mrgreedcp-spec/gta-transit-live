import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { handleAuth, authEnabled } from './auth.js';
import { plan, geocode, plannerUsage } from './planner.js';
import { take, clientKey } from './ratelimit.js';
import { AGENCIES, byId } from './agencies.js';
import { getFeed, feedStatus, vehiclesOf, arrivalsAt, tripDelays, routeStyle } from './realtime.js';
import { store, loadStatic, staticStatus, searchStops, stopsNear, stopsInBbox } from './static.js';
import { goKey, goGet, goStatus, goVehicles, goArrivals, goUnionDepartures, goAlerts, goFares } from './go.js';

const PORT = +process.env.PORT || 8821;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(import.meta.dirname, '..');
const STATIC_DIRS = { '/leaflet/': path.join(ROOT, 'node_modules/leaflet/dist'), '/': path.join(ROOT, 'public') };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };
const NO_CACHE = /(\.html|\.webmanifest|\/sw\.js)$/;
const now = () => Math.floor(Date.now() / 1000);

function compress(req, headers, buf) {
  if (buf.length > 1024 && /\bgzip\b/.test(req?.headers['accept-encoding'] || '')) {
    headers['content-encoding'] = 'gzip'; headers.vary = 'accept-encoding';
    return zlib.gzipSync(buf);
  }
  return buf;
}
function send(res, code, body) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const buf = compress(res.req, headers, Buffer.from(JSON.stringify(body)));
  res.writeHead(code, headers);
  res.end(buf);
}

function pickAgencies(q) {
  const ids = q ? q.split(',').filter(id => byId[id]) : AGENCIES.map(a => a.id);
  return ids.map(id => byId[id]).filter(a => a.enabled);
}

async function apiStatus() {
  return {
    now: now(),
    agencies: AGENCIES.map(a => ({
      id: a.id, name: a.name, color: a.color, enabled: a.enabled, note: a.note || '',
      static: staticStatus(a.id),
      vehicles: a.goApi ? goStatus() : feedStatus(a, 'vehicles'),
      tripUpdates: a.goApi ? goStatus() : feedStatus(a, 'tripUpdates'),
    })),
  };
}

async function apiVehicles(q, bboxStr) {
  const list = await Promise.all(pickAgencies(q).map(async a => {
    if (a.goApi) {
      if (!goKey()) return [];
      try { return await goVehicles(store[a.id]); } catch { return []; }
    }
    // 延误来自 TripUpdates，最多等 1.5 秒，拿不到就显示灰色
    const [s, tu] = await Promise.all([getFeed(a, 'vehicles'), a.tripUpdatesUrl ? getFeed(a, 'tripUpdates', 1500) : null]);
    return vehiclesOf(a, s, store[a.id], tripDelays(tu));
  }));
  let vehicles = list.flat();
  const b = (bboxStr || '').split(',').map(Number);
  if (b.length === 4 && b.every(Number.isFinite)) {
    const [w, so, e, n] = b, dx = (e - w) * 0.2, dy = (n - so) * 0.2;
    vehicles = vehicles.filter(v => v.lon >= w - dx && v.lon <= e + dx && v.lat >= so - dy && v.lat <= n + dy);
  }
  return { now: now(), vehicles };
}

async function apiArrivals(agencyId, stopId, { limit = 20, maxWaitMs = 30000 } = {}) {
  const a = byId[agencyId];
  if (!a) return [404, { error: 'unknown agency' }];
  const st = store[a.id];
  const stop = st?.stopById.get(stopId) || null;
  const t = now();
  const window = x => x.time >= t - 60 && x.time <= t + 5400;
  if (a.goApi) {
    if (!goKey()) return [200, { now: t, stop, arrivals: [], note: 'GO 实时需要 API key（免费申请）。' }];
    try {
      const code = stop?.code || stopId;
      const arrivals = (await goArrivals(code)).map(x => ({ ...x, routeColor: a.color, textColor: '#fff' })).filter(window)  .sort((x, y) => x.time - y.time).slice(0, limit);
      return [200, { now: t, stop, arrivals, note: '' }];
    } catch (e) { return [200, { now: t, stop, arrivals: [], note: `GO 接口错误：${e.message}` }]; }
  }
  const s = await getFeed(a, 'tripUpdates', maxWaitMs);
  const raw = arrivalsAt(s, stopId);
  if (raw == null) return [200, { now: t, stop, arrivals: [], note: `${a.name} 实时到站暂不可用：${s.error || (s.inflight ? '加载中' : '无数据')}` }];
  const arrivals = raw.filter(window).sort((x, y) => x.time - y.time).slice(0, limit).map(x => {
    const trip = x.tripId && st ? st.trips.get(x.tripId) : null;
    const routeId = x.routeId || trip?.[0];
    const r = routeId && st ? st.routes.get(routeId) : null;
    const style = routeStyle(r, a.color);
    return { routeShort: r?.[0] || routeId || '?', routeColor: style.color, textColor: style.text, headsign: trip?.[1] || r?.[1] || '', time: x.time, delaySec: x.delay, vehicleId: x.vehicleId, tripId: x.tripId };
  });
  return [200, { now: t, stop, arrivals, note: '' }];
}

// 批量到站：/api/arrivals?s=miway:0085&s=brampton:00045505&limit=2
async function apiBatchArrivals(q) {
  const limit = Math.min(Math.max(+q.get('limit') || 2, 1), 5);
  const items = q.getAll('s').slice(0, 30).map(x => { const i = x.indexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; });
  const results = new Array(items.length);
  const queue = items.map((it, i) => [it, i]);
  // GTFS-RT 同机构共用一份 feed；GO 每站一次请求，所以整体限并发 3，慢源最多等 5 秒
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const [[agency, id], i] = queue.shift();
      const [code, body] = await apiArrivals(agency, id, { limit, maxWaitMs: 5000 });
      results[i] = code === 200
        ? { agency, id, arrivals: body.arrivals.map(({ routeShort, routeColor, textColor, headsign, time, delaySec, platform }) => ({ routeShort, routeColor, textColor, headsign, time, delaySec, platform })), note: body.note }
        : { agency, id, arrivals: [], note: body.error || 'error' };
    }
  }));
  return { now: now(), results };
}

const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
// 反向代理（云端）后面 remoteAddress 是代理地址，不能当本机
const isLocalReq = req => !process.env.RENDER && !req.headers['x-forwarded-for'] && isLoopback(req.socket.remoteAddress);

async function handleApi(url, res, req) {
  const p = url.pathname, q = url.searchParams;
  const who = clientKey(req);
  const limited = kind => { const wait = take(kind, who); if (!wait) return false; res.setHeader('retry-after', String(wait)); send(res, 429, { error: 'rate_limited', retryAfter: wait }); return true; };
  if (limited('api')) return;
  if (p === '/api/status') return send(res, 200, { ...(await apiStatus()), planner: plannerUsage() });
  if (p === '/api/plan') {
    const pt = v => { const a = (v || '').split(',').map(Number); return a.length === 2 && a.every(Number.isFinite) ? a : null; };
    const from = pt(q.get('from')), to = pt(q.get('to'));
    if (!from || !to) return send(res, 400, { error: 'from/to = lat,lon' });
    if (limited('plan')) return;
    return send(res, 200, await plan({ from, to, time: +q.get('time') || null, arriveBy: q.get('arriveBy') === '1' }));
  }
  if (p === '/api/geocode') {
    const text = (q.get('q') || '').trim().slice(0, 100);
    if (text.length < 2) return send(res, 200, []);
    if (limited('geo')) return;
    try { return send(res, 200, await geocode(text)); } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (p === '/api/vehicles') return send(res, 200, await apiVehicles(q.get('agencies'), q.get('bbox')));
  if (p === '/api/stops/near') {
    const lat = +q.get('lat'), lon = +q.get('lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: 'lat/lon required' });
    const ids = pickAgencies(q.get('agencies')).map(a => a.id);
    return send(res, 200, stopsNear(lat, lon, ids, { radius: Math.min(+q.get('radius') || 800, 3000), limit: Math.min(+q.get('limit') || 12, 30) }));
  }
  if (p === '/api/stops/bbox') {
    const [w, so, e, n] = ['w', 's', 'e', 'n'].map(k => +q.get(k));
    if (![w, so, e, n].every(Number.isFinite)) return send(res, 400, { error: 'w,s,e,n required' });
    const ids = pickAgencies(q.get('agencies')).map(a => a.id);
    return send(res, 200, stopsInBbox(w, so, e, n, ids, Math.min(+q.get('limit') || 300, 500)));
  }
  if (p === '/api/routes') {
    const st = store[q.get('agency')];
    return send(res, 200, st ? [...st.routes].map(([id, [s, l, c]]) => ({ agency: q.get('agency'), id, short: s, long: l, color: c })) : []);
  }
  if (p === '/api/stops/search') {
    const ids = pickAgencies(q.get('agencies')).map(a => a.id);
    return send(res, 200, searchStops(q.get('q') || '', ids, Math.min(+q.get('limit') || 20, 50)));
  }
  if (p === '/api/arrivals') return send(res, 200, await apiBatchArrivals(q));
  let m = p.match(/^\/api\/stops\/([^/]+)\/(.+)\/arrivals$/);
  if (m) { const [code, body] = await apiArrivals(m[1], decodeURIComponent(m[2])); return send(res, code, body); }

  // GO OpenDataAPI
  if (p.startsWith('/api/go/')) {
    if (!goKey()) return send(res, 503, { error: 'no_key', hint: '设置 GO_API_KEY 或存进钥匙串 go-api-key' });
    try {
      if (p === '/api/go/union') return send(res, 200, { now: now(), departures: await goUnionDepartures() });
      if (p === '/api/go/alerts') return send(res, 200, { now: now(), alerts: await goAlerts() });
      if (p === '/api/go/fares') return send(res, 200, await goFares(q.get('from') || '', q.get('to') || ''));
      m = p.match(/^\/api\/go\/raw\/(.+)$/); // 透传任意官方 V1 接口，如 /api/go/raw/Schedule/Line/All/20261115
      if (m && !isLocalReq(req)) return send(res, 403, { error: 'raw 只允许本机访问' });
      if (m) return send(res, 200, await goGet(m[1] + (url.search || '')));
    } catch (e) { return send(res, 502, { error: e.message }); }
  }
  send(res, 404, { error: 'not found' });
}

async function serveFile(url, res) {
  for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
    if (!url.pathname.startsWith(prefix)) continue;
    let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    const file = path.join(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) break;
    try {
      const raw = await readFile(file);
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      const headers = { 'content-type': type, ...(NO_CACHE.test(file) ? { 'cache-control': 'no-cache' } : {}) };
      const buf = /text|javascript|json/.test(type) ? compress(res.req, headers, raw) : raw;
      res.writeHead(200, headers);
      return res.end(buf);
    } catch { /* try next */ }
  }
  res.writeHead(404); res.end('not found');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (await handleAuth(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) await handleApi(url, res, req);
    else await serveFile(url, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e?.message || e) });
  }
}).listen(PORT, HOST, () => {
  console.log(`GTA 公交实时：http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1') {
    for (const list of Object.values(os.networkInterfaces())) for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) console.log(`手机（同一 Wi-Fi）打开：http://${n.address}:${PORT}`);
    console.log(`或：http://${os.hostname().replace(/\.local$/, '')}.local:${PORT}`);
  }
  console.log(`网络代理：${process.env.HTTPS_PROXY || process.env.https_proxy || '无（直连）'}`);
  console.log(`访问密码：${authEnabled ? '已启用' : '未启用'}`);
  console.log(`GO API key：${goKey() ? '已配置' : '未配置（GO 只显示静态站点）'}`);
});

// 后台加载静态 GTFS（并发 3）
(async () => {
  const queue = AGENCIES.filter(a => a.enabled && a.staticUrl);
  await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await loadStatic(queue.shift()); }));
  console.log('[static] 全部处理完毕');
})();
