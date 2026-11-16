import GtfsRt from 'gtfs-realtime-bindings';
import { AGENCIES } from './agencies.js';
import { fetchBuffer, errMsg } from './fetch.js';

const { FeedMessage } = GtfsRt.transit_realtime;
const TTL_MS = 15000;
const num = v => v == null ? null : (typeof v === 'object' ? (v.toNumber ? v.toNumber() : Number(v)) : Number(v));

// cache[agencyId][kind] = { feed, feedTs, fetchedAt, error, errorAt, inflight, stopIndex }
const cache = {};

function slot(id, kind) {
  cache[id] ??= {};
  return (cache[id][kind] ??= { feed: null, feedTs: null, fetchedAt: 0, error: null, errorAt: 0, inflight: null });
}

function urlFor(a, kind) { return kind === 'vehicles' ? a.vehiclesUrl : a.tripUpdatesUrl; }

// 返回最近一次成功的 feed（过期则先拉一次）。失败时保留旧数据并记录错误。
export async function getFeed(a, kind, maxWaitMs = 4000) {
  const s = slot(a.id, kind);
  const url = urlFor(a, kind);
  if (!a.enabled || !url) return s;
  const fresh = Date.now() - Math.max(s.fetchedAt, s.errorAt) < TTL_MS;
  if (fresh) return s;
  if (!s.inflight) {
    s.inflight = (async () => {
      try {
        const buf = await fetchBuffer(url, kind === 'tripUpdates' ? 30000 : 12000);
        const feed = FeedMessage.decode(buf);
        s.feed = feed;
        s.feedTs = num(feed.header?.timestamp);
        s.fetchedAt = Date.now();
        s.error = null;
        s.stopIndex = null;
        s.delays = null;
        s.tripIndex = null;
      } catch (e) {
        s.error = errMsg(e);
        s.errorAt = Date.now();
      } finally {
        s.inflight = null;
      }
    })();
  }
  // 慢源（如连不通的 TTC）最多等 4 秒，先返回已有数据，不拖慢整体。
  await Promise.race([s.inflight, new Promise(r => setTimeout(r, maxWaitMs))]);
  return s;
}

export function feedStatus(a, kind) {
  const s = slot(a.id, kind);
  let state;
  if (!a.enabled) state = 'disabled';
  else if (a.requiresKey && !a.hasKey) state = 'no_key';
  else if (s.error && s.feed) state = 'stale';
  else if (s.error) state = 'error';
  else if (s.feed) state = 'ok';
  else state = 'idle';
  const count = s.feed ? s.feed.entity.length : 0;
  return { state, count, feedTs: s.feedTs, fetchedAt: s.fetchedAt ? Math.round(s.fetchedAt / 1000) : null, error: s.error };
}

const has = (o, k) => !!o && Object.hasOwn(o, k); // protobuf 缺省字段读出来是 0，必须判断是否真的存在

// 线路颜色：空或接近白色时回退机构色
export function routeStyle(r, agencyColor) {
  let c = r?.[2] ? '#' + r[2].replace(/^#/, '') : '';
  if (!/^#[0-9a-f]{6}$/i.test(c)) c = '';
  if (c) { const n = parseInt(c.slice(1), 16); const lum = 0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255); if (lum > 225) c = ''; }
  const color = c || agencyColor;
  let text = r?.[4] && /^#?[0-9a-f]{6}$/i.test(r[4]) && c ? '#' + r[4].replace(/^#/, '') : '';
  if (!text) { const n = parseInt(color.slice(1), 16); text = (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 160 ? '#111' : '#fff'; }
  return { color, text };
}

export function modeOf(r) {
  const t = r?.[3];
  if (t == null) return 'bus';
  if (t === 0 || (t >= 900 && t < 1000)) return 'tram';
  if (t === 1 || (t >= 400 && t < 500)) return 'subway';
  if (t === 2 || (t >= 100 && t < 200)) return 'train';
  return 'bus';
}

function eventDelay(ev) {
  if (!ev) return null;
  if (has(ev, 'delay')) return ev.delay;
  if (has(ev, 'time') && has(ev, 'scheduledTime')) return num(ev.time) - num(ev.scheduledTime);
  return null;
}

// tripId / vehicleId -> 当前延误秒数（取“下一站”）
function buildDelays(s) {
  const byTrip = new Map(), byVeh = new Map();
  const t = Date.now() / 1000 - 30;
  for (const e of s.feed.entity) {
    const tu = e.tripUpdate;
    if (!tu) continue;
    const stus = tu.stopTimeUpdate || [];
    let u = stus.find(x => (num(x.arrival?.time) || num(x.departure?.time) || 0) >= t) || stus[stus.length - 1];
    let d = u ? (eventDelay(u.arrival) ?? eventDelay(u.departure)) : null;
    if (d == null && has(tu, 'delay')) d = tu.delay;
    if (d == null) continue;
    if (tu.trip?.tripId) byTrip.set(tu.trip.tripId, d);
    if (tu.vehicle?.id) byVeh.set(tu.vehicle.id, d);
  }
  return { byTrip, byVeh };
}

export function tripDelays(s) {
  if (!s?.feed) return null;
  s.delays ??= buildDelays(s);
  return s.delays;
}

export function vehiclesOf(a, s, st, delays) {
  if (!s.feed) return [];
  const out = [];
  for (const e of s.feed.entity) {
    const v = e.vehicle;
    if (!v?.position) continue;
    const tripId = v.trip?.tripId || null;
    const t = tripId && st ? st.trips.get(tripId) : null;
    const routeId = v.trip?.routeId || t?.[0] || null;
    const r = routeId && st ? st.routes.get(routeId) : null;
    const style = routeStyle(r, a.color);
    out.push({
      agency: a.id,
      id: v.vehicle?.id || e.id,
      label: v.vehicle?.label || null,
      tripId,
      lat: v.position.latitude,
      lon: v.position.longitude,
      bearing: has(v.position, 'bearing') ? Math.round(v.position.bearing) : null,
      routeId,
      routeShort: r?.[0] || routeId,
      headsign: t?.[1] || '',
      ts: num(v.timestamp) || s.feedTs,
      delaySec: delays ? (delays.byTrip.get(tripId) ?? delays.byVeh.get(v.vehicle?.id) ?? null) : null,
      routeColor: style.color, textColor: style.text, mode: modeOf(r),
    });
  }
  return out;
}

// stop_id -> [{ tripId, routeId, time, delay, vehicleId }]
function buildStopIndex(s) {
  const idx = new Map();
  for (const e of s.feed.entity) {
    const tu = e.tripUpdate;
    if (!tu?.stopTimeUpdate) continue;
    if (tu.trip?.scheduleRelationship === 3 || tu.trip?.scheduleRelationship === 'CANCELED') continue;
    for (const u of tu.stopTimeUpdate) {
      if (!u.stopId) continue;
      if (u.scheduleRelationship === 1 || u.scheduleRelationship === 'SKIPPED') continue;
      const time = num(u.arrival?.time) || num(u.departure?.time);
      if (!time) continue;
      const delay = eventDelay(u.arrival) ?? eventDelay(u.departure);
      let list = idx.get(u.stopId);
      if (!list) idx.set(u.stopId, (list = []));
      list.push({ tripId: tu.trip?.tripId || null, routeId: tu.trip?.routeId || null, time, delay, vehicleId: tu.vehicle?.id || null });
    }
  }
  return idx;
}

// 某趟车的 TripUpdate：先按 tripId 找，找不到按车辆 id 找
export function tripUpdateOf(s, tripId, vehicleId) {
  if (!s?.feed) return null;
  if (!s.tripIndex) {
    const byTrip = new Map(), byVeh = new Map();
    for (const e of s.feed.entity) {
      const tu = e.tripUpdate;
      if (!tu) continue;
      if (tu.trip?.tripId) byTrip.set(tu.trip.tripId, tu);
      if (tu.vehicle?.id) byVeh.set(tu.vehicle.id, tu);
    }
    s.tripIndex = { byTrip, byVeh };
  }
  return (tripId && s.tripIndex.byTrip.get(tripId)) || (vehicleId && s.tripIndex.byVeh.get(vehicleId)) || null;
}

// TripUpdate → 剩余站点列表（实时时间优先，计划时间能推就推）
export function tripStops(tu, st, nowSec) {
  const out = [];
  let passed = 0;
  (tu?.stopTimeUpdate || []).forEach((u, i) => {
    const time = num(u.arrival?.time) || num(u.departure?.time);
    if (!time) return;
    if (time < nowSec - 30) { passed++; return; }
    const delaySec = eventDelay(u.arrival) ?? eventDelay(u.departure);
    const sch = num(u.arrival?.scheduledTime) || num(u.departure?.scheduledTime) || null;
    const stop = u.stopId && st ? st.stopById.get(u.stopId) : null;
    out.push({
      seq: has(u, 'stopSequence') ? u.stopSequence : i,
      id: u.stopId || null, code: stop?.code || null, name: stop?.name || null, lat: stop?.lat ?? null, lon: stop?.lon ?? null,
      time, sched: sch ?? (delaySec != null ? time - delaySec : null), delaySec,
      skipped: u.scheduleRelationship === 1 || u.scheduleRelationship === 'SKIPPED',
    });
  });
  out.sort((a, b) => a.time - b.time);
  return { stops: out, passedCount: passed };
}

export function arrivalsAt(s, stopId) {
  if (!s.feed) return null;
  s.stopIndex ??= buildStopIndex(s);
  return s.stopIndex.get(stopId) || [];
}

export { AGENCIES };
