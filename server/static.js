// 静态 GTFS：下载 → 只读 routes/stops/trips 必要列 → 写精简 JSON 缓存。
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import yauzl from 'yauzl';
import { downloadTo, errMsg } from './fetch.js';

const DATA = path.resolve(import.meta.dirname, '..', 'data');
const MAX_AGE_MS = (+process.env.STATIC_MAX_AGE_DAYS || 7) * 24 * 3600 * 1000;
const CACHE_V = 3; // 解析格式版本，变了就重下（3：加线路走向 shapes）
const RETRY_MS = 10 * 60 * 1000;

// store[id] = { state, routes: Map, stops: [], stopById: Map, trips: Map, downloadedAt, error }
export const store = {};

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function openZip(file) {
  return new Promise((res, rej) => yauzl.open(file, { lazyEntries: true }, (e, z) => e ? rej(e) : res(z)));
}

// 读 zip 中指定的几个 txt，对每行调用 onRow(fileName, obj)
async function readTables(file, wanted) {
  const zip = await openZip(file);
  const found = new Set();
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      const base = path.basename(entry.fileName).toLowerCase();
      const spec = wanted[base];
      if (!spec || found.has(base)) return zip.readEntry();
      found.add(base);
      zip.openReadStream(entry, async (err, stream) => {
        if (err) return reject(err);
        try {
          const rl = createInterface({ input: stream, crlfDelay: Infinity });
          let idx = null; // 列下标只在表头算一次（shapes.txt 近百万行）
          for await (let line of rl) {
            if (!idx) { const cols = parseCsvLine(line.replace(/^﻿/, '')).map(s => s.trim()); idx = spec.cols.map(k => cols.indexOf(k)); continue; }
            if (!line) continue;
            const v = parseCsvLine(line);
            const o = {};
            for (let j = 0; j < idx.length; j++) { const i = idx[j]; o[spec.cols[j]] = i >= 0 ? (v[i] ?? '').trim() : ''; }
            spec.onRow(o);
          }
          zip.readEntry();
        } catch (e) { reject(e); }
      });
    });
    zip.readEntry();
  });
  zip.close();
  for (const k of Object.keys(wanted)) if (!found.has(k) && !wanted[k].optional) throw new Error(`zip 缺少 ${k}`);
}

async function parseZip(file) {
  const routes = {}, stops = [], trips = {}, rawShapes = new Map();
  const hs = new Map(); const headsigns = [];
  const hsIdx = s => { let i = hs.get(s); if (i === undefined) { i = headsigns.length; headsigns.push(s); hs.set(s, i); } return i; };
  await readTables(file, {
    'routes.txt': { cols: ['route_id', 'route_short_name', 'route_long_name', 'route_color', 'route_type', 'route_text_color'],
      onRow: r => { routes[r.route_id] = [r.route_short_name, r.route_long_name, r.route_color, r.route_type === '' ? null : +r.route_type, r.route_text_color]; } },
    'stops.txt': { cols: ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon'],
      onRow: r => { if (r.stop_lat) stops.push([r.stop_id, r.stop_code, r.stop_name, +r.stop_lat, +r.stop_lon]); } },
    'trips.txt': { cols: ['trip_id', 'route_id', 'trip_headsign', 'direction_id', 'shape_id'],
      onRow: r => { trips[r.trip_id] = [r.route_id, hsIdx(r.trip_headsign), r.direction_id === '' ? null : +r.direction_id, r.shape_id]; } },
    'shapes.txt': { optional: true, cols: ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
      onRow: r => { let a = rawShapes.get(r.shape_id); if (!a) rawShapes.set(r.shape_id, (a = [])); a.push(+r.shape_pt_sequence, +r.shape_pt_lat, +r.shape_pt_lon); } },
  });
  // 只处理被 trip 用到的 shape：排序 → 5 米 Douglas-Peucker 简化 → polyline（精度 5）
  const shapes = [], shapeIdx = new Map();
  for (const t of Object.values(trips)) {
    const sid = t[3];
    let i = -1;
    if (sid && shapeIdx.has(sid)) i = shapeIdx.get(sid);
    else if (sid && rawShapes.has(sid)) {
      const a = rawShapes.get(sid), pts = [];
      for (let k = 0; k < a.length; k += 3) pts.push([a[k], a[k + 1], a[k + 2]]);
      pts.sort((x, y) => x[0] - y[0]);
      i = shapes.length;
      shapes.push(encodePolyline(simplifyDP(pts.map(p => [p[1], p[2]]), 5)));
      shapeIdx.set(sid, i);
      rawShapes.delete(sid);
    } else if (sid) shapeIdx.set(sid, -1);
    t[3] = i;
  }
  rawShapes.clear();
  return { routes, stops, trips, headsigns, shapes };
}

// 迭代版 Douglas-Peucker。pts = [[lat, lon], ...]，tolM 为米
function simplifyDP(pts, tolM) {
  if (pts.length < 3) return pts;
  const kx = 111320 * Math.cos(43.7 * Math.PI / 180), ky = 110540;
  const xy = pts.map(([la, lo]) => [lo * kx, la * ky]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tolM * tolM;
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = xy[s], [bx, by] = xy[e];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol2;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * dx - px, qy = ay + t * dy - py, d = qx * qx + qy * qy;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function encodePolyline(pts, precision = 5) {
  const f = 10 ** precision;
  let out = '', pLat = 0, pLon = 0;
  const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, lo] of pts) {
    const a = Math.round(la * f), b = Math.round(lo * f);
    out += enc(a - pLat) + enc(b - pLon);
    pLat = a; pLon = b;
  }
  return out;
}

function hydrate(id, j, downloadedAt) {
  const trips = new Map();
  for (const [k, [rid, h, d, sh]] of Object.entries(j.trips)) trips.set(k, [rid, j.headsigns[h], d, sh ?? -1]);
  const stops = j.stops.map(([sid, code, name, lat, lon]) => ({ id: sid, code, name, lat, lon, lname: name.toLowerCase() }));
  store[id] = {
    state: 'ready', routes: new Map(Object.entries(j.routes)), stops,
    stopById: new Map(stops.map(s => [s.id, s])), trips, shapes: j.shapes || [], routeShapeCache: new Map(), downloadedAt, error: null,
  };
}

// 某趟车的走向（polyline 精度 5），没有返回 null
export function shapeOf(st, tripId) {
  const i = st?.trips.get(tripId)?.[3];
  return i != null && i >= 0 ? st.shapes[i] || null : null;
}

// 某条线路每个方向最常用的走向（最多 2 条）。routeKey 可以是 route_id 或线路号（GO 实时只给线路号）
export function routeShapes(st, routeKey) {
  if (!st || !routeKey || !st.shapes?.length) return [];
  const key = String(routeKey);
  if (st.routeShapeCache.has(key)) return st.routeShapeCache.get(key);
  const ids = new Set();
  for (const [rid, r] of st.routes) if (rid === key || r[0] === key) ids.add(rid);
  const count = new Map(); // dir -> Map(shapeIdx -> n)
  for (const [, t] of st.trips) {
    if (!ids.has(t[0]) || t[3] < 0) continue;
    const d = t[2] ?? 0;
    let m = count.get(d); if (!m) count.set(d, (m = new Map()));
    m.set(t[3], (m.get(t[3]) || 0) + 1);
  }
  const out = [];
  for (const m of count.values()) { const best = [...m].sort((a, b) => b[1] - a[1])[0]; if (best && !out.includes(st.shapes[best[0]])) out.push(st.shapes[best[0]]); }
  const res = out.slice(0, 2);
  st.routeShapeCache.set(key, res);
  return res;
}

async function refresh(a) {
  const dir = path.join(DATA, a.id);
  await mkdir(dir, { recursive: true });
  const zip = path.join(dir, 'feed.zip');
  const t0 = Date.now();
  await downloadTo(a.staticUrl, zip);
  const j = await parseZip(zip);
  const downloadedAt = Date.now();
  await writeFile(path.join(dir, 'static.json'), JSON.stringify(j));
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ v: CACHE_V, downloadedAt, url: a.staticUrl }));
  await rm(zip, { force: true }); // 解析完不再需要，避免占空间
  hydrate(a.id, j, downloadedAt);
  console.log(`[static] ${a.id} 下载+解析完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，routes=${Object.keys(j.routes).length} stops=${j.stops.length} trips=${Object.keys(j.trips).length} shapes=${j.shapes.length}`);
}

const attempts = {};
export async function loadStatic(a) {
  const dir = path.join(DATA, a.id);
  store[a.id] ??= { state: 'loading', routes: new Map(), stops: [], stopById: new Map(), trips: new Map(), shapes: [], routeShapeCache: new Map() };
  let needDownload = true;
  try {
    const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
    await stat(path.join(dir, 'static.json'));
    if (meta.v === CACHE_V) {
      hydrate(a.id, JSON.parse(await readFile(path.join(dir, 'static.json'), 'utf8')), meta.downloadedAt);
      needDownload = Date.now() - meta.downloadedAt > MAX_AGE_MS;
    }
  } catch { /* 没缓存 */ }
  if (!needDownload) return;
  try {
    await refresh(a);
  } catch (e) {
    const s = store[a.id];
    s.error = errMsg(e);
    if (s.state !== 'ready') s.state = 'error';
    attempts[a.id] = (attempts[a.id] || 0) + 1;
    const wait = attempts[a.id] <= 2 ? 30000 : RETRY_MS;
    console.warn(`[static] ${a.id} 失败：${s.error}，${wait / 1000} 秒后重试`);
    setTimeout(() => loadStatic(a), wait).unref();
  }
}

export function staticStatus(id) {
  const s = store[id];
  if (!s) return { state: 'missing' };
  return { state: s.state, routes: s.routes.size, stops: s.stops.length, trips: s.trips.size,
    downloadedAt: s.downloadedAt ? Math.round(s.downloadedAt / 1000) : null, error: s.error || null };
}

export function searchStops(q, agencies, limit = 20) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const exact = [], prefix = [], sub = [];
  for (const id of agencies) {
    const s = store[id];
    if (!s || s.state !== 'ready') continue;
    for (const st of s.stops) {
      const hit = { agency: id, id: st.id, code: st.code, name: st.name, lat: st.lat, lon: st.lon };
      if (st.code.toLowerCase() === q || st.id.toLowerCase() === q) exact.push(hit);
      else if (st.code.toLowerCase().startsWith(q)) prefix.push(hit);
      else if (st.lname.includes(q)) sub.push(hit);
    }
  }
  return [...exact, ...prefix, ...sub].slice(0, limit);
}

// ---------- 空间查询（全量约 2.4 万站，线性扫描足够） ----------
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function stopsNear(lat, lon, agencies, { radius = 800, limit = 12 } = {}) {
  const dLat = radius / 111000, dLon = radius / (111000 * Math.cos(lat * Math.PI / 180));
  const out = [];
  for (const id of agencies) {
    const s = store[id];
    if (!s || s.state !== 'ready') continue;
    for (const st of s.stops) {
      if (Math.abs(st.lat - lat) > dLat || Math.abs(st.lon - lon) > dLon) continue;
      const dist = distM(lat, lon, st.lat, st.lon);
      if (dist <= radius) out.push({ agency: id, id: st.id, code: st.code, name: st.name, lat: st.lat, lon: st.lon, dist: Math.round(dist) });
    }
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, limit);
}

export function stopsInBbox(w, so, e, n, agencies, limit = 300) {
  const out = [];
  let truncated = false;
  for (const id of agencies) {
    const s = store[id];
    if (!s || s.state !== 'ready') continue;
    for (const st of s.stops) {
      if (st.lat < so || st.lat > n || st.lon < w || st.lon > e) continue;
      if (out.length >= limit) { truncated = true; break; }
      out.push({ agency: id, id: st.id, code: st.code, name: st.name, lat: st.lat, lon: st.lon });
    }
  }
  return { stops: out, truncated };
}
