// GO Transit OpenDataAPI（https://api.openmetrolinx.com/OpenDataAPI/Help）
// 免费，但需注册拿 key。key 来源：环境变量 GO_API_KEY，否则读 macOS 钥匙串 go-api-key。
import { execFileSync } from 'node:child_process';
import { errMsg } from './fetch.js';
import { routeStyle } from './realtime.js';

const BASE = (process.env.GO_API_BASE || 'https://api.openmetrolinx.com/OpenDataAPI/api/V1').replace(/\/$/, '');
const TTL_MS = 15000;
let KEY;

export function goKey() {
  if (KEY !== undefined) return KEY;
  KEY = process.env.GO_API_KEY || '';
  if (!KEY && process.platform === 'darwin') {
    try { KEY = execFileSync('security', ['find-generic-password', '-s', 'go-api-key', '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { KEY = ''; }
  }
  return KEY;
}

// 允许透传的接口前缀（官方文档全部 V1 分组）
const ALLOWED = /^(Stop|ServiceUpdate|ServiceataGlance|Schedule|Fares|Fleet|Gtfs|UP)\//;

const cache = new Map(); // path -> { at, data, error, inflight }
const status = { lastOkAt: null, lastError: null };

// 调 GO API（JSON）。path 例：'Stop/NextService/UN'
export async function goGet(path, { ttl = TTL_MS } = {}) {
  if (!goKey()) throw new Error('no_key');
  if (!ALLOWED.test(path)) throw new Error('path_not_allowed');
  let c = cache.get(path);
  if (c && Date.now() - c.at < ttl && !c.inflight) {
    if (c.error) throw new Error(c.error);
    return c.data;
  }
  if (!c) cache.set(path, (c = { at: 0 }));
  c.inflight ??= (async () => {
    try {
      const sep = path.includes('?') ? '&' : '?';
      const r = await fetch(`${BASE}/${path}${sep}key=${encodeURIComponent(goKey())}`,
        { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const code = j?.Metadata?.ErrorCode;
      if (code && !['200', '0', ''].includes(String(code))) throw new Error(`GO ${code} ${j.Metadata.ErrorMessage || ''}`.trim());
      c.data = j; c.error = null; status.lastOkAt = Date.now(); status.lastError = null;
    } catch (e) {
      c.error = errMsg(e); status.lastError = c.error;
    } finally {
      c.at = Date.now(); c.inflight = null;
    }
  })();
  await c.inflight;
  if (c.error) throw new Error(c.error);
  return c.data;
}

export function goStatus() {
  if (!goKey()) return { state: 'no_key', count: 0, error: null };
  if (status.lastError) return { state: status.lastOkAt ? 'stale' : 'error', count: 0, error: status.lastError };
  return { state: status.lastOkAt ? 'ok' : 'idle', count: lastVehicleCount, fetchedAt: status.lastOkAt ? Math.round(status.lastOkAt / 1000) : null };
}

// GO 时间是多伦多本地时间字符串 "2026-11-15 10:30:00" → epoch 秒
export function torontoToEpoch(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(asUtc)).map(x => [x.type, x.value]));
  const tzAsUtc = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - (tzAsUtc - asUtc)) / 1000);
}

const arr = x => Array.isArray(x) ? x : x ? [x] : [];
let lastVehicleCount = 0;

// 列车 + 巴士实时位置（ServiceataGlance）
export async function goVehicles(st) {
  const out = [];
  const errors = [];
  // GO 静态 route_id 形如 "01260426-LW"，按 route_short_name 对上 LineCode
  const byShort = new Map();
  for (const [, r] of st?.routes || []) if (r[0]) byShort.set(r[0], r);
  for (const kind of ['Trains', 'Buses']) {
    try {
      const j = await goGet(`ServiceataGlance/${kind}/All`);
      for (const t of arr(j?.Trips?.Trip)) {
        if (t.Latitude == null || t.Longitude == null) continue;
        const r = st?.routes.get(t.LineCode) || byShort.get(t.LineCode);
        const style = routeStyle(r, '#3d8c2f');
        out.push({
          agency: 'go', id: `${kind[0]}${t.TripNumber}`, label: t.TripNumber,
          lat: +t.Latitude, lon: +t.Longitude, bearing: t.Course ?? null,
          routeId: t.LineCode, routeShort: t.LineCode, routeLong: r?.[1] || '', routeColor: style.color, textColor: style.text,
          headsign: t.Display || '', dir: t.VariantDir ?? null, tripId: t.TripNumber,
          ts: torontoToEpoch(t.ModifiedDate),
          mode: kind === 'Trains' ? 'train' : 'bus',
          delaySec: t.DelaySeconds ?? null, occupancy: t.OccupancyPercentage ?? null,
          nextStop: t.NextStopCode || null, cars: t.Cars || null,
        });
      }
    } catch (e) { errors.push(`${kind}: ${e.message}`); }
  }
  lastVehicleCount = out.length;
  if (errors.length === 2) throw new Error(errors.join('; '));
  return out;
}

// 某站下一班（Stop/NextService/{StopCode}）
export async function goArrivals(stopCode) {
  const j = await goGet(`Stop/NextService/${encodeURIComponent(stopCode)}`);
  return arr(j?.NextService?.Lines).map(l => {
    const sched = torontoToEpoch(l.ScheduledDepartureTime);
    const comp = torontoToEpoch(l.ComputedDepartureTime) || sched;
    return {
      routeShort: l.LineCode, headsign: l.DirectionName || l.LineName || '',
      time: comp, delaySec: sched && comp ? comp - sched : null,
      tripId: l.TripNumber, vehicleId: null,
      platform: l.ActualPlatform || l.ScheduledPlatform || null,
      status: l.DepartureStatus || l.Status || null, mode: l.ServiceType === 'T' ? 'train' : l.ServiceType === 'B' ? 'bus' : null,
    };
  }).filter(a => a.time);
}

export async function goUnionDepartures() {
  const j = await goGet('ServiceUpdate/UnionDepartures/All');
  return arr(j?.AllDepartures?.Trip).map(t => ({
    tripId: t.TripNumber, service: t.Service, serviceType: t.ServiceType, platform: t.Platform,
    info: t.Info, time: torontoToEpoch(t.Time), stops: arr(t.Stops).map(s => s.Name),
  }));
}

export async function goAlerts() {
  const j = await goGet('ServiceUpdate/ServiceAlert/All', { ttl: 60000 });
  return arr(j?.Messages?.Message).map(m => ({
    code: m.Code, status: m.Status, posted: torontoToEpoch(m.PostedDateTime),
    subject: m.SubjectEnglish, body: m.BodyEnglish, category: m.Category,
    lines: arr(m.Lines).map(l => l.Code),
  }));
}

export async function goFares(from, to) {
  return goGet(`Fares/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, { ttl: 3600000 });
}
