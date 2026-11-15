// 路线规划：Transitous（MOTIS 2，https://transitous.org/api/）
// 使用条件：开源、非商业、/plan 每天少于 720 次；请求带 User-Agent（应用名、版本、联系方式）；页面显示数据来源链接。
// 结果叠加本地实时数据，给出换乘衔接判断。没有结果或被关闭时，前端改为跳转 Google 地图。
import { byId } from './agencies.js';
import { getFeed, arrivalsAt, tripDelays } from './realtime.js';
import { store } from './static.js';
import { errMsg } from './fetch.js';

const BASE = 'https://api.transitous.org/api';
const UA = `gta-transit-live/0.2 (+${process.env.PLANNER_CONTACT || 'https://github.com/mrgreedcp-spec/gta-transit-live'})`;
const MODE = (process.env.PLANNER || 'auto').toLowerCase(); // auto | transitous | off
const DAILY_MAX = +process.env.PLANNER_DAILY_MAX || 600;    // 留余量，低于官方 720 次/天

// Transitous 的机构前缀 → 本地机构 id
const PREFIX = [
  ['ca-on-Metrolinx-gotransit_', 'go'],
  ['ca-on-TTC_', 'ttc'],
  ['ca-on-MiWay_', 'miway'],
  ['ca-on-Brampton-Transit_', 'brampton'],
  ['ca-on-York-Region-Transit_', 'yrt'],
  ['ca-on-Durham-Region-Transit_', 'durham'],
];
function splitId(fullId) {
  if (!fullId) return [null, null];
  let best = null;
  for (const [p, ag] of PREFIX) {
    const i = fullId.lastIndexOf(p);
    if (i >= 0 && (!best || i > best[0])) best = [i, p, ag];
  }
  return best ? [best[2], fullId.slice(best[0] + best[1].length)] : [null, fullId];
}

export const plannerEnabled = MODE !== 'off';
let day = '', used = 0;
const cache = new Map(); // key -> { at, data }

const epoch = s => (s ? Math.round(Date.parse(s) / 1000) : null);
const torontoDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());

export function plannerUsage() { return { enabled: plannerEnabled, provider: 'transitous', today: day === torontoDay() ? used : 0, dailyMax: DAILY_MAX }; }

async function callTransitous(path, params) {
  const r = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA, accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Transitous HTTP ${r.status}`);
  return r.json();
}

// 地址/地名搜索（Transitous geocode），只返回多伦多一带
export async function geocode(text) {
  const key = 'g:' + text.toLowerCase();
  const c = cache.get(key);
  if (c && Date.now() - c.at < 3600e3) return c.data;
  const j = await callTransitous('/v1/geocode', { text, place: '43.70,-79.42', placeBias: '5' });
  const data = (Array.isArray(j) ? j : []).filter(x => x.lat > 42.8 && x.lat < 44.6 && x.lon > -80.6 && x.lon < -78.3).slice(0, 8)
    .map(x => ({ name: x.name, area: (x.areas || []).filter(a => a.matched || a.default).map(a => a.name).slice(0, 2).join(', '), lat: x.lat, lon: x.lon, type: x.type }));
  cache.set(key, { at: Date.now(), data });
  return data;
}

function normLeg(l) {
  const transit = l.mode !== 'WALK' && l.mode !== 'BIKE' && l.mode !== 'CAR';
  const [agency, tripId] = splitId(l.tripId);
  const [, fromStop] = splitId(l.from?.stopId);
  const [, toStop] = splitId(l.to?.stopId);
  return {
    mode: l.mode, transit, agency: transit ? agency : null, agencyName: l.agencyName || null,
    routeShort: l.routeShortName || l.displayName || '', routeLong: l.routeLongName || '',
    routeColor: l.routeColor ? '#' + l.routeColor : null, textColor: l.routeTextColor ? '#' + l.routeTextColor : null,
    headsign: l.headsign || '', tripId,
    from: { name: l.from?.name, lat: l.from?.lat, lon: l.from?.lon, stopId: fromStop, code: l.from?.stopCode || null },
    to: { name: l.to?.name, lat: l.to?.lat, lon: l.to?.lon, stopId: toStop, code: l.to?.stopCode || null },
    start: epoch(l.startTime), end: epoch(l.endTime), schedStart: epoch(l.scheduledStartTime), schedEnd: epoch(l.scheduledEndTime),
    realTime: !!l.realTime, duration: l.duration, distance: l.distance ?? null, stops: (l.intermediateStops || []).length,
    geometry: l.legGeometry?.points || '', precision: l.legGeometry?.precision || 6,
  };
}

// 用本地实时数据修正每一程的上车/下车时间
async function overlayRealtime(leg) {
  leg.rt = null;
  const a = leg.transit && leg.agency ? byId[leg.agency] : null;
  if (!a || a.goApi || !a.tripUpdatesUrl || !leg.tripId) return;
  const s = await getFeed(a, 'tripUpdates', 3000);
  if (!s.feed) return;
  const find = stopId => (stopId ? (arrivalsAt(s, stopId) || []).find(x => x.tripId === leg.tripId) : null);
  const dep = find(leg.from.stopId), arr = find(leg.to.stopId);
  const delay = tripDelays(s)?.byTrip.get(leg.tripId);
  if (dep || arr || delay != null) {
    leg.rt = {
      start: dep?.time ?? (delay != null ? leg.schedStart + delay : leg.start),
      end: arr?.time ?? (delay != null ? leg.schedEnd + delay : leg.end),
      delaySec: delay ?? (dep ? dep.time - leg.schedStart : null),
    };
  }
}

// 下一程赶不上时，找同站同线路的下一班
async function nextAlternative(leg, after) {
  const a = leg.agency ? byId[leg.agency] : null;
  if (!a || a.goApi || !a.tripUpdatesUrl || !leg.from.stopId) return null;
  const s = await getFeed(a, 'tripUpdates', 1500);
  const st = store[a.id];
  const list = (arrivalsAt(s, leg.from.stopId) || []).filter(x => x.time >= after).sort((x, y) => x.time - y.time);
  for (const x of list) {
    const routeId = x.routeId || st?.trips.get(x.tripId)?.[0];
    const short = routeId && st?.routes.get(routeId)?.[0];
    if (short === leg.routeShort || routeId === leg.routeShort) return { time: x.time, tripId: x.tripId };
  }
  return null;
}

async function connections(legs) {
  const out = [];
  const idx = legs.map((l, i) => (l.transit ? i : -1)).filter(i => i >= 0);
  for (let k = 0; k + 1 < idx.length; k++) {
    const a = legs[idx[k]], b = legs[idx[k + 1]];
    const walk = legs.slice(idx[k] + 1, idx[k + 1]).reduce((t, l) => t + (l.duration || 0), 0);
    const arrive = a.rt?.end ?? a.end;
    const depart = b.rt?.start ?? b.start;
    const buffer = depart - (arrive + walk);
    const status = buffer >= 180 ? 'ok' : buffer >= 0 ? 'tight' : 'miss';
    const c = { fromLeg: idx[k], toLeg: idx[k + 1], walkSec: walk, bufferSec: buffer, status, live: !!(a.rt || b.rt) };
    if (status === 'miss') c.next = await nextAlternative(b, arrive + walk);
    out.push(c);
  }
  return out;
}

export async function plan({ from, to, time, arriveBy }) {
  if (!plannerEnabled) return { fallback: 'google', reason: 'disabled' };
  const key = JSON.stringify([from, to, time ? Math.round(time / 60) : Math.round(Date.now() / 60000), !!arriveBy]);
  const c = cache.get(key);
  if (c && Date.now() - c.at < 60e3) return c.data;
  const today = torontoDay();
  if (day !== today) { day = today; used = 0; }
  if (used >= DAILY_MAX) return { fallback: 'google', reason: 'quota' };
  used++;
  const params = { fromPlace: `${from[0]},${from[1]}`, toPlace: `${to[0]},${to[1]}`, numItineraries: '4', maxTransfers: '4' };
  if (time) params.time = new Date(time * 1000).toISOString();
  if (arriveBy) params.arriveBy = 'true';
  let j;
  try { j = await callTransitous('/v5/plan', params); }
  catch (e) { return { fallback: 'google', reason: 'error', error: errMsg(e) }; }
  const its = (j.itineraries || []).slice(0, 4);
  if (!its.length) return { fallback: 'google', reason: 'empty' };
  const itineraries = [];
  for (const it of its) {
    const legs = it.legs.map(normLeg);
    await Promise.all(legs.map(l => overlayRealtime(l).catch(() => {})));
    itineraries.push({
      start: epoch(it.startTime), end: epoch(it.endTime), duration: it.duration, transfers: it.transfers,
      legs, connections: await connections(legs),
    });
  }
  const data = { provider: 'transitous', now: Math.floor(Date.now() / 1000), itineraries };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}
