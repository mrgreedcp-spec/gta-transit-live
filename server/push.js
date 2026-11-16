// 到站推送提醒（Web Push）。
// 每台设备 = 一个推送订阅，规则挂在设备上：push:dev:<id> = { sub, rules, lang, created, digest? }；push:index = [id...]
// digest = 每日收藏摘要（见 digest.js），到点推一条收藏站点的下两班。
// 服务端每 30 秒检查一次处于时间窗内的规则；只在有规则生效时才拉实时数据。
// 需要环境变量 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT；本地没有时自动生成并存到 data/vapid.json。
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as webpush from 'web-push';
import { kvGet, kvSet, kvDel, kvPersistent } from './kv.js';
import { digestDue, digestLastCall, buildDigest, cleanDigest } from './digest.js';

const MAX_DEVICES = 300, MAX_RULES = 10;
const ALLOWED_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|android\.googleapis\.com)$/;
const devices = new Map(); // id -> { sub, rules, lang, created }
const fired = new Map();   // `${devId}:${ruleId}:${tripId}` -> 时间戳（去重，3 小时）
let vapid = null, ready = false, arrivalsFn = null;
export const pushState = { enabled: false, reason: '', sent: 0, failed: 0, lastError: null, lastCheck: null };

async function loadVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (process.env.RENDER) return null; // 云端必须用固定密钥，否则重启后旧订阅全部失效
  const file = path.resolve(import.meta.dirname, '..', 'data', 'vapid.json');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch {}
  const keys = webpush.generateVAPIDKeys();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(keys));
  console.log(`[push] 已生成本地 VAPID 密钥：${file}`);
  return keys;
}

export async function initPush(getArrivals) {
  arrivalsFn = getArrivals;
  vapid = await loadVapid();
  if (!vapid) { pushState.reason = '云端未配置 VAPID 密钥'; return; }
  if (!kvPersistent) { pushState.reason = '云端未配置 Upstash，提醒无法持久保存'; return; }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://github.com/mrgreedcp-spec/gta-transit-live', vapid.publicKey, vapid.privateKey);
  try {
    const ids = (await kvGet('push:index')) || [];
    for (const id of ids) { const d = await kvGet('push:dev:' + id); if (d) devices.set(id, d); }
    ready = true;
    pushState.enabled = true;
    console.log(`[push] 已启用，设备 ${devices.size} 台`);
    setInterval(() => check().catch(e => { pushState.lastError = e.message; }), 30000).unref();
  } catch (e) {
    pushState.reason = `存储不可用：${e.message}`;
  }
}

export const vapidPublicKey = () => vapid?.publicKey || null;
const devId = endpoint => crypto.createHash('sha256').update(endpoint).digest('base64url').slice(0, 22);
async function saveDevice(id) { await kvSet('push:dev:' + id, devices.get(id)); }
async function saveIndex() { await kvSet('push:index', [...devices.keys()]); }

function validSub(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === 'https:' && ALLOWED_HOSTS.test(u.hostname) && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string';
  } catch { return false; }
}

export async function subscribe(sub, lang) {
  if (!ready) throw Object.assign(new Error(pushState.reason || 'push_disabled'), { code: 503 });
  if (!validSub(sub)) throw Object.assign(new Error('invalid_subscription'), { code: 400 });
  const id = devId(sub.endpoint);
  const old = devices.get(id);
  if (!old && devices.size >= MAX_DEVICES) throw Object.assign(new Error('too_many_devices'), { code: 429 });
  devices.set(id, { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, rules: old?.rules || [], lang: lang || 'zh', created: old?.created || Date.now(), digest: old?.digest });
  await saveDevice(id);
  if (!old) await saveIndex();
  return { id, rules: devices.get(id).rules };
}

export async function unsubscribe(id) {
  if (!devices.has(id)) return;
  devices.delete(id);
  await kvDel('push:dev:' + id);
  await saveIndex();
}

export function getRules(id) { return devices.get(id)?.rules || null; }

// ---------- 每日收藏摘要 ----------
export function getDigest(id) {
  const d = devices.get(id);
  if (!d) throw Object.assign(new Error('unknown_device'), { code: 404 });
  return d.digest || null;
}

export async function setDigest(id, input) {
  const d = devices.get(id);
  if (!d) throw Object.assign(new Error('unknown_device'), { code: 404 });
  const dg = cleanDigest(input || {}, d.digest);
  if (!dg) throw Object.assign(new Error('invalid_digest'), { code: 400 });
  // 改了时间或刚打开：今天已过点就从明天开始，免得一保存就推
  const t = torontoNow();
  if ((input?.at || input?.enabled) && t.hm > dg.at) dg.lastDate = t.date;
  d.digest = dg;
  await saveDevice(id);
  return dg;
}

// 给 Mac 端提醒器（POST/GET /api/notify* 密钥鉴权）：所有启用摘要的时间，用来到点前叫醒本服务。不含站点和设备。
export function digestSchedule() {
  if (!ready) throw Object.assign(new Error(pushState.reason || 'push_disabled'), { code: 503 });
  const seen = new Map();
  for (const d of devices.values()) {
    const g = d.digest;
    if (g?.enabled && g.stops?.length) seen.set(`${g.at}|${g.days.join(',')}`, { at: g.at, days: [...g.days] });
  }
  return [...seen.values()].sort((x, y) => (x.at + x.days).localeCompare(y.at + y.days));
}

async function digestPayload(dg) {
  const arr = new Map();
  for (const s of dg.stops.slice(0, 8)) {
    try { arr.set(`${s.agency}:${s.id}`, await arrivalsFn(s.agency, s.id)); } catch { arr.set(`${s.agency}:${s.id}`, []); }
  }
  return buildDigest(dg.stops, arr, Math.floor(Date.now() / 1000), torontoNow().hm);
}

export async function sendDigestNow(id) {
  const dg = devices.get(id)?.digest;
  if (!dg?.stops?.length) throw Object.assign(new Error('no_favorites'), { code: 400 });
  const m = await digestPayload(dg);
  if (!await send(id, { title: m.title, body: m.body, tag: 'digest', url: '/?tab=favs' }, 1800)) throw Object.assign(new Error(pushState.lastError || 'send_failed'), { code: 502 });
}

async function checkDigests(t) {
  for (const [id, d] of devices) {
    const dg = d.digest;
    if (!digestDue(dg, t)) continue;
    const m = await digestPayload(dg);
    if (m.empty && !digestLastCall(dg, t)) continue; // 刚唤醒、实时数据还没到：下一轮再试
    if (await send(id, { title: m.title, body: m.body, tag: 'digest', url: '/?tab=favs' }, 1800)) {
      dg.lastDate = t.date;
      await saveDevice(id);
    }
  }
}

// rule: { stop:{agency,id,name}, route?:string, lead:分钟, days:[0-6], from:'HH:MM', to:'HH:MM', once:bool }
export async function addRule(id, r) {
  const d = devices.get(id);
  if (!d) throw Object.assign(new Error('unknown_device'), { code: 404 });
  if (d.rules.length >= MAX_RULES) throw Object.assign(new Error('too_many_rules'), { code: 429 });
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const rule = {
    id: crypto.randomBytes(6).toString('base64url'),
    stop: { agency: String(r.stop?.agency || ''), id: String(r.stop?.id || ''), name: String(r.stop?.name || '').slice(0, 80) },
    route: r.route ? String(r.route).slice(0, 12) : null,
    lead: Math.min(30, Math.max(1, Math.round(+r.lead || 5))),
    days: Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter(x => x >= 0 && x <= 6))] : [0, 1, 2, 3, 4, 5, 6],
    from: hhmm.test(r.from) ? r.from : '00:00', to: hhmm.test(r.to) ? r.to : '23:59',
    once: !!r.once, enabled: true,
  };
  if (!rule.stop.agency || !rule.stop.id || !rule.days.length) throw Object.assign(new Error('invalid_rule'), { code: 400 });
  d.rules.push(rule);
  await saveDevice(id);
  return rule;
}

export async function deleteRule(id, ruleId) {
  const d = devices.get(id);
  if (!d) return;
  d.rules = d.rules.filter(r => r.id !== ruleId);
  await saveDevice(id);
}

async function send(id, payload, ttl = 120) {
  const d = devices.get(id);
  if (!d) return false;
  try {
    await webpush.sendNotification(d.sub, JSON.stringify(payload), {
      TTL: ttl, urgency: 'high', timeout: 10000,
      ...(process.env.HTTPS_PROXY && !process.env.RENDER ? { proxy: process.env.HTTPS_PROXY } : {}),
    });
    pushState.sent++;
    return true;
  } catch (e) {
    pushState.failed++; pushState.lastError = `${e.statusCode || ''} ${e.body || e.message}`.trim().slice(0, 200);
    if (e.statusCode === 404 || e.statusCode === 410) await unsubscribe(id); // 订阅已失效
    return false;
  }
}

export async function sendTest(id) {
  if (!devices.has(id)) throw Object.assign(new Error('unknown_device'), { code: 404 });
  const zh = devices.get(id).lang !== 'en';
  const ok = await send(id, { title: zh ? 'GTA 公交实时' : 'GTA Transit Live', body: zh ? '测试通知：推送提醒已开通 ✅' : 'Test: reminders are on ✅', tag: 'test' });
  if (!ok) throw Object.assign(new Error(pushState.lastError || 'send_failed'), { code: 502 });
}

// 外部提醒（POST /api/notify，见 index.js）：发给全部设备。key 用于去重，同一 key 6 小时内只发一次。
const notified = new Map();
export async function notifyAll({ title, body, tag, key }) {
  if (!ready) throw Object.assign(new Error(pushState.reason || 'push_disabled'), { code: 503 });
  const now = Date.now();
  for (const [k, t] of notified) if (now - t > 6 * 3600e3) notified.delete(k);
  if (key && notified.has(key)) return { devices: devices.size, sent: 0, duplicate: true };
  let sent = 0;
  for (const id of [...devices.keys()]) if (await send(id, { title, body, tag, url: '/' }, 1800)) sent++;
  if (key && sent) notified.set(key, now);
  return { devices: devices.size, sent };
}

// ---------- 定时检查 ----------
function torontoNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date()); // YYYY-MM-DD
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hm: `${p.hour}:${p.minute}`, date };
}
const inWindow = (r, t) => r.enabled && r.days.includes(t.day) && (r.from <= r.to ? t.hm >= r.from && t.hm <= r.to : t.hm >= r.from || t.hm <= r.to);

async function check() {
  pushState.lastCheck = Math.floor(Date.now() / 1000);
  const now = Date.now();
  for (const [k, t] of fired) if (now - t > 3 * 3600e3) fired.delete(k);
  const t = torontoNow();
  try { await checkDigests(t); } catch (e) { pushState.lastError = `digest: ${e.message}`; }
  const active = [];
  for (const [id, d] of devices) for (const r of d.rules) if (inWindow(r, t)) active.push([id, d, r]);
  if (!active.length) return; // 没有生效的规则就不拉任何数据
  const byStop = new Map();
  for (const [, , r] of active) byStop.set(`${r.stop.agency}:${r.stop.id}`, r.stop);
  const arrivals = new Map();
  for (const [key, s] of byStop) {
    try { arrivals.set(key, await arrivalsFn(s.agency, s.id)); } catch { arrivals.set(key, []); }
  }
  const nowS = Math.floor(now / 1000);
  for (const [id, d, r] of active) {
    const list = arrivals.get(`${r.stop.agency}:${r.stop.id}`) || [];
    const hit = list.find(a => (!r.route || String(a.routeShort).toLowerCase() === r.route.toLowerCase())
      && a.time - nowS <= r.lead * 60 && a.time - nowS >= -30);
    if (!hit) continue;
    const key = `${id}:${r.id}:${hit.tripId || hit.time}`;
    if (fired.has(key)) continue;
    fired.set(key, now);
    const min = Math.max(0, Math.round((hit.time - nowS) / 60));
    const zh = d.lang !== 'en';
    const body = zh
      ? `${hit.routeShort} 路${hit.headsign ? `（${hit.headsign}）` : ''}${min <= 0 ? '即将到站' : ` ${min} 分钟后到站`}`
      : `Route ${hit.routeShort}${hit.headsign ? ` (${hit.headsign})` : ''} ${min <= 0 ? 'arriving now' : `in ${min} min`}`;
    await send(id, { title: r.stop.name, body, tag: `r-${r.id}`, url: `/?stop=${encodeURIComponent(`${r.stop.agency}:${r.stop.id}`)}` });
    if (r.once) { r.enabled = false; await saveDevice(id); }
  }
}
