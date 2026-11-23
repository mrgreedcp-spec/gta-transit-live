import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { handleAuth, authEnabled } from './auth.js';
import { plan, geocode, plannerUsage } from './planner.js';
import { take, clientKey } from './ratelimit.js';
import { initPush, pushState, vapidPublicKey, subscribe, unsubscribe, getRules, addRule, deleteRule, sendTest, notifyAll, getDigest, setDigest, sendDigestNow, digestSchedule, digestStats,
  usePushAccounts, acctRules, acctAddRule, acctDeleteRule, acctGetDigest, acctSetDigest, acctUnsubscribe, acctSendTest, acctSendDigestNow, rebindSession, deviceCountByUser } from './push.js';
import { kvStatus } from './kv.js';
import { accountsOn, accountsWanted, accountsWhyOff, startAccounts, sessionCookie, clearCookies } from './auth-accounts.js';
import { logout, changePassword, getFavs, setFavs, isAdmin, renameUser, adminList, adminResetPassword, normalizeName } from './accounts.js';
import { startGrowth, growthStats, adminAsset } from './growth.js';

async function readJson(req, limit = 16384) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > limit) throw Object.assign(new Error('body_too_large'), { code: 413 }); }
  try { return JSON.parse(data || '{}'); } catch { throw Object.assign(new Error('bad_json'), { code: 400 }); }
}
import { AGENCIES, byId } from './agencies.js';
import { getFeed, feedStatus, vehiclesOf, arrivalsAt, tripDelays, routeStyle, modeOf, tripUpdateOf, tripStops } from './realtime.js';
import { store, loadStatic, staticStatus, searchStops, stopsNear, stopsInBbox, shapeOf, routeShapes } from './static.js';
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

// 单趟车：线路走向 + 剩余站点（Livemap 式点车查看）
// /api/trip/:agency/:tripId?veh=<车辆id>&route=<route_id 或线路号>；tripId 为 "-" 表示车辆没带 trip
async function apiTrip(agencyId, tripIdRaw, q) {
  const a = byId[agencyId];
  if (!a) return [404, { error: 'unknown agency' }];
  const st = store[a.id];
  const t = now();
  let tripId = tripIdRaw === '-' ? null : tripIdRaw;
  const veh = q.get('veh') || null;
  let routeKey = q.get('route') || null;
  let shape = null, shapeSource = null, shapes = [], stops = [], passedCount = 0, stopsSource = 'none', note = '';
  if (a.goApi) {
    // GO 静态 trip_id 形如 20261127-56-56720（日期-线路-车次），实时只给车次号
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date()).replaceAll('-', '');
    if (tripId && routeKey) shape = shapeOf(st, `${ymd}-${routeKey}-${tripId}`);
    note = 'GO 暂不提供逐站时间，只显示线路走向。';
  } else {
    if (tripId) shape = shapeOf(st, tripId);
    if (a.tripUpdatesUrl) {
      const s = await getFeed(a, 'tripUpdates', 5000);
      const tu = tripUpdateOf(s, tripId, veh);
      if (tu) {
        tripId ||= tu.trip?.tripId || null;
        routeKey ||= tu.trip?.routeId || null;
        if (!shape && tripId) shape = shapeOf(st, tripId);
        ({ stops, passedCount } = tripStops(tu, st, t));
        if (stops.length) stopsSource = 'realtime'; else note = passedCount ? '这趟车的预测站点都已过站。' : '这趟车暂时没有逐站预测。';
      } else note = s?.feed ? '这趟车暂时没有逐站预测。' : `${a.name} 实时到站暂不可用：${s?.error || '加载中'}`;
    } else note = `${a.name} 不提供逐站预测。`;
  }
  if (shape) { shapes = [shape]; shapeSource = 'trip'; }
  const trip = tripId && st ? st.trips.get(tripId) : null;
  routeKey ||= trip?.[0] || null;
  if (!shapes.length && routeKey) { shapes = routeShapes(st, routeKey); if (shapes.length) shapeSource = 'route'; }
  const routeId = trip?.[0] || routeKey;
  let r = routeId && st ? st.routes.get(routeId) : null;
  if (!r && routeKey && st) for (const [, x] of st.routes) if (x[0] === routeKey) { r = x; break; }
  const style = routeStyle(r, a.color);
  let delaySec = null;
  if (!a.goApi && a.tripUpdatesUrl) { const d = tripDelays(await getFeed(a, 'tripUpdates', 0)); delaySec = d ? (d.byTrip.get(tripId) ?? d.byVeh.get(veh) ?? null) : null; }
  return [200, {
    now: t, agency: a.id, tripId, routeId, routeShort: r?.[0] || routeKey || '', routeLong: r?.[1] || '',
    routeColor: style.color, textColor: style.text, mode: a.goApi ? null : modeOf(r), headsign: trip?.[1] || '',
    delaySec, shapes, shapeSource, stops, passedCount, stopsSource, note,
  }];
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
  // 管理员（ADMIN_USER 指定的账号）。没设 ADMIN_USER、旧模式、不是管理员：一律 404，和不存在的接口一样
  if (p.startsWith('/api/admin/')) {
    if (!req.user || !isAdmin(req.user.id)) return send(res, 404, { error: 'not found' });
    try {
      if (p === '/api/admin/accounts' && req.method === 'GET') {
        const list = adminList(req.user.id), counts = deviceCountByUser();
        return send(res, 200, { ...list, users: list.users.map(u => ({ ...u, devices: counts[u.id] || 0 })) });
      }
      if (p === '/api/admin/growth' && req.method === 'GET') return send(res, 200, growthStats(req.user.id));
      if (p === '/api/admin/reset' && req.method === 'POST') {
        if (limited('write') || limited('login')) return;
        const b = (await readJson(req, 2048)) || {};
        const r = await adminResetPassword(req.user.id, String(b.id || ''));
        return send(res, 200, { ok: true, ...r });
      }
    } catch (e) { return send(res, e.code || 500, { error: e.message }); }
    return send(res, 404, { error: 'not found' });
  }
  if (p.startsWith('/api/account/') || p === '/api/favs') {
    if (!req.user) return send(res, 404, { error: 'not found' });   // 旧模式（共享密码）没有账号接口；前端据此判断
    const m = req.method;
    try {
      if (p === '/api/account/me' && m === 'GET') return send(res, 200, { user: { id: req.user.id, name: req.user.name,
        ...(req.user.mustChange ? { mustChange: true } : {}), ...(isAdmin(req.user.id) ? { admin: true } : {}) } });
      if (p === '/api/favs' && m === 'GET') return send(res, 200, getFavs(req.user.id));
      if (m !== 'GET' && limited('write')) return;
      if (p === '/api/favs' && m === 'PUT') { const b = await readJson(req, 32768); return send(res, 200, await setFavs(req.user.id, b.favs, b.base)); }
      if (p === '/api/account/logout' && m === 'POST') {
        const b = await readJson(req, 2048).catch(() => ({}));
        if (typeof b.dev === 'string' && b.dev) await acctUnsubscribe(req.user.id, b.dev).catch(() => {});   // 这台设备不再收这个账号的提醒
        await logout(req.user.id, req.user.sid); res.setHeader('set-cookie', clearCookies); return send(res, 200, { ok: true }); }
      if (p === '/api/account/password' && m === 'POST') {
        if (limited('login')) return;
        const b = await readJson(req, 2048);
        const s = await changePassword(req.user.id, b.old, b.new, process.env.APP_PASSWORD || '');
        res.setHeader('set-cookie', sessionCookie(req, s.cookie, s.maxAge));
        await rebindSession(req.user.id, req.user.sid, s.cookie.split('.')[2]).catch(() => {});   // cookie: v1.<uid>.<sid>.<exp>.<mac>
        return send(res, 200, { ok: true });
      }
      if (p === '/api/account/name' && m === 'POST') {
        if (limited('login')) return;
        const b = (await readJson(req, 2048)) || {};
        return send(res, 200, { user: await renameUser(req.user.id, b.name, b.password) });   // cookie 里是 uid，不用换
      }
    } catch (e) { return send(res, e.code || 500, e.body || { error: e.message }); }
    return send(res, 404, { error: 'not found' });
  }
  if (p === '/api/status') return send(res, 200, { ...(await apiStatus()), planner: plannerUsage(), push: { ...pushState }, kv: kvStatus() });
  if (p.startsWith('/api/push/')) {
    const m = req.method;
    try {
      if (p === '/api/push/key') return send(res, 200, { publicKey: vapidPublicKey(), enabled: pushState.enabled, reason: pushState.reason });
      if (m !== 'GET' && limited('write')) return;
      if (req.user) {   // 账号模式：规则、摘要读写当前账号；设备 id 不再作为归属依据
        const u = req.user.id;
        if (p === '/api/push/subscribe' && m === 'POST') { const b = await readJson(req); return send(res, 200, await subscribe(b.sub || {}, b.lang, u, req.user.sid)); }
        if (p === '/api/push/subscribe' && m === 'DELETE') { await acctUnsubscribe(u, q.get('id')); return send(res, 200, { ok: true }); }
        if (p === '/api/push/rules' && m === 'GET') return send(res, 200, acctRules(u));
        if (p === '/api/push/rules' && m === 'POST') { const b = await readJson(req); return send(res, 200, await acctAddRule(u, b.rule || {})); }
        if (p === '/api/push/rules' && m === 'DELETE') { await acctDeleteRule(u, q.get('rule')); return send(res, 200, { ok: true }); }
        if (p === '/api/push/test' && m === 'POST') { const b = await readJson(req); await (b.digest ? acctSendDigestNow(u) : acctSendTest(u)); return send(res, 200, { ok: true }); }
        if (p === '/api/push/digest' && m === 'GET') return send(res, 200, { digest: acctGetDigest(u) });
        if (p === '/api/push/digest' && m === 'POST') { const b = await readJson(req); return send(res, 200, { digest: await acctSetDigest(u, b.digest) }); }
        return send(res, 404, { error: 'not found' });
      }
      if (p === '/api/push/subscribe' && m === 'POST') { const b = await readJson(req); return send(res, 200, await subscribe(b.sub || {}, b.lang)); }
      if (p === '/api/push/subscribe' && m === 'DELETE') { await unsubscribe(q.get('id')); return send(res, 200, { ok: true }); }
      if (p === '/api/push/rules' && m === 'GET') { const r = getRules(q.get('id')); return r ? send(res, 200, r) : send(res, 404, { error: 'unknown_device' }); }
      if (p === '/api/push/rules' && m === 'POST') { const b = await readJson(req); return send(res, 200, await addRule(b.id, b.rule || {})); }
      if (p === '/api/push/rules' && m === 'DELETE') { await deleteRule(q.get('id'), q.get('rule')); return send(res, 200, { ok: true }); }
      if (p === '/api/push/test' && m === 'POST') { const b = await readJson(req); await (b.digest ? sendDigestNow(b.id) : sendTest(b.id)); return send(res, 200, { ok: true }); }
      if (p === '/api/push/digest' && m === 'GET') return send(res, 200, { digest: getDigest(q.get('id')) });
      if (p === '/api/push/digest' && m === 'POST') { const b = await readJson(req); return send(res, 200, { digest: await setDigest(b.id, b.digest) }); }
    } catch (e) { return send(res, e.code || 500, { error: e.message }); }
    return send(res, 404, { error: 'not found' });
  }
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
  let m = p.match(/^\/api\/trip\/([^/]+)\/(.+)$/);
  if (m) { const [code, body] = await apiTrip(m[1], decodeURIComponent(m[2]), q); return send(res, code, body); }
  m = p.match(/^\/api\/stops\/([^/]+)\/(.+)\/arrivals$/);
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

// 外部提醒：本机脚本带 x-notify-key（= 环境变量 NOTIFY_SECRET）调用，推给全部设备。未设 NOTIFY_SECRET 时接口不存在。
// 外部调用（Mac 端提醒器）的密钥校验；通过返回 true，否则已写好错误响应
function notifyAuth(req, res, method) {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret) { send(res, 404, { error: 'not found' }); return false; }
  if (req.method !== method) { send(res, 405, { error: 'method_not_allowed' }); return false; }
  const wait = take('write', clientKey(req));
  if (wait) { res.setHeader('retry-after', String(wait)); send(res, 429, { error: 'rate_limited', retryAfter: wait }); return false; }
  const got = Buffer.from(String(req.headers['x-notify-key'] || '')), want = Buffer.from(secret);
  if (!got.length) { send(res, 401, { error: 'unauthorized' }); return false; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) { send(res, 403, { error: 'forbidden' }); return false; }
  return true;
}

// GET /api/notify/schedule：每日收藏摘要的时间表，Mac 据此在到点前 5 分钟叫醒服务器
async function handleNotifySchedule(req, res) {
  if (!notifyAuth(req, res, 'GET')) return;
  try { return send(res, 200, { schedule: digestSchedule(), stats: digestStats() }); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
}

async function handleNotify(req, res) {
  if (!notifyAuth(req, res, 'POST')) return;
  try {
    const b = await readJson(req, 2048);
    const body = String(b.body || '').trim().slice(0, 300);
    if (!body) return send(res, 400, { error: 'body_required' });
    return send(res, 200, await notifyAll({ title: String(b.title || '通勤提醒').slice(0, 60), body, tag: String(b.tag || 'notify').slice(0, 40), key: String(b.key || '').slice(0, 80) }));
  } catch (e) { return send(res, e.code || 500, { error: e.message }); }
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

// 增长仪表盘页面：文件在仓库 admin/ 目录，只给管理员；其他人和不存在的路径一样 404
async function serveAdmin(url, res, req) {
  const f = adminAsset(url.pathname, req.user?.id);
  if (!f) { res.writeHead(404); return res.end('not found'); }
  const raw = await readFile(path.join(ROOT, 'admin', f));
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(raw);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname === '/api/notify') return await handleNotify(req, res);
    if (url.pathname === '/api/notify/schedule') return await handleNotifySchedule(req, res);
    if (await handleAuth(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) await handleApi(url, res, req);
    else if (url.pathname === '/admin' || url.pathname === '/admin.js') await serveAdmin(url, res, req);
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
  if (accountsWanted) console.log(accountsOn ? '账号模式：已启用（APP_PASSWORD 作邀请码）' : `账号模式：未启用，退回共享密码。原因：${accountsWhyOff}`);
  console.log(`存储：${kvStatus().kind}${kvStatus().persistent ? '' : '（非持久）'}`);
  console.log(`GO API key：${goKey() ? '已配置' : '未配置（GO 只显示静态站点）'}`);
});

startAccounts();
usePushAccounts(accountsOn);
if (accountsOn && normalizeName(process.env.ADMIN_USER || '')) startGrowth().catch(e => console.warn('[growth] 启动失败', e.message));

// 推送提醒：用和到站接口相同的逻辑取到站
initPush(async (agency, stopId) => (await apiArrivals(agency, stopId, { limit: 15, maxWaitMs: 8000 }))[1].arrivals || [])
  .catch(e => console.warn('[push] 初始化失败', e.message));

// 后台加载静态 GTFS（并发 3）
(async () => {
  const queue = AGENCIES.filter(a => a.enabled && a.staticUrl);
  await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await loadStatic(queue.shift()); }));
  console.log('[static] 全部处理完毕');
})();
