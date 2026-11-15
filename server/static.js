// 静态 GTFS：下载 → 只读 routes/stops/trips 必要列 → 写精简 JSON 缓存。
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import yauzl from 'yauzl';
import { downloadTo, errMsg } from './fetch.js';

const DATA = path.resolve(import.meta.dirname, '..', 'data');
const MAX_AGE_MS = (+process.env.STATIC_MAX_AGE_DAYS || 7) * 24 * 3600 * 1000;
const CACHE_V = 2; // 解析格式版本，变了就重下
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
          let cols = null;
          for await (let line of rl) {
            if (!cols) { cols = parseCsvLine(line.replace(/^﻿/, '')).map(s => s.trim()); continue; }
            if (!line) continue;
            const v = parseCsvLine(line);
            const o = {};
            for (const k of spec.cols) { const i = cols.indexOf(k); o[k] = i >= 0 ? (v[i] ?? '').trim() : ''; }
            spec.onRow(o);
          }
          zip.readEntry();
        } catch (e) { reject(e); }
      });
    });
    zip.readEntry();
  });
  zip.close();
  for (const k of Object.keys(wanted)) if (!found.has(k)) throw new Error(`zip 缺少 ${k}`);
}

async function parseZip(file) {
  const routes = {}, stops = [], trips = {};
  const hs = new Map(); const headsigns = [];
  const hsIdx = s => { let i = hs.get(s); if (i === undefined) { i = headsigns.length; headsigns.push(s); hs.set(s, i); } return i; };
  await readTables(file, {
    'routes.txt': { cols: ['route_id', 'route_short_name', 'route_long_name', 'route_color', 'route_type', 'route_text_color'],
      onRow: r => { routes[r.route_id] = [r.route_short_name, r.route_long_name, r.route_color, r.route_type === '' ? null : +r.route_type, r.route_text_color]; } },
    'stops.txt': { cols: ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon'],
      onRow: r => { if (r.stop_lat) stops.push([r.stop_id, r.stop_code, r.stop_name, +r.stop_lat, +r.stop_lon]); } },
    'trips.txt': { cols: ['trip_id', 'route_id', 'trip_headsign', 'direction_id'],
      onRow: r => { trips[r.trip_id] = [r.route_id, hsIdx(r.trip_headsign), r.direction_id === '' ? null : +r.direction_id]; } },
  });
  return { routes, stops, trips, headsigns };
}

function hydrate(id, j, downloadedAt) {
  const trips = new Map();
  for (const [k, [rid, h, d]] of Object.entries(j.trips)) trips.set(k, [rid, j.headsigns[h], d]);
  const stops = j.stops.map(([sid, code, name, lat, lon]) => ({ id: sid, code, name, lat, lon, lname: name.toLowerCase() }));
  store[id] = {
    state: 'ready', routes: new Map(Object.entries(j.routes)), stops,
    stopById: new Map(stops.map(s => [s.id, s])), trips, downloadedAt, error: null,
  };
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
  console.log(`[static] ${a.id} 下载+解析完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，routes=${Object.keys(j.routes).length} stops=${j.stops.length} trips=${Object.keys(j.trips).length}`);
}

const attempts = {};
export async function loadStatic(a) {
  const dir = path.join(DATA, a.id);
  store[a.id] ??= { state: 'loading', routes: new Map(), stops: [], stopById: new Map(), trips: new Map() };
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
