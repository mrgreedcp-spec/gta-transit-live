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
import { getData, updateData, uidByName, acctState, sessionAlive } from './accounts.js';

// 账号模式（index.js 在 ACCOUNTS 生效时打开）：设备带 userId 的，提醒规则和摘要存在账号里（acct:data:<uid>），
// 发到该账号的全部设备；没认领的设备照旧用自己的规则。关闭时完全按设备（与改动前一致），设备上保留的是认领那一刻的快照。
let acctMode = false;
export function usePushAccounts(on) { acctMode = !!on; }

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
  await loadDevices();
}

// 从存储载入全部设备。冷启动时 Upstash 偶尔超时：失败就 30 秒后重试，不让推送整段停掉。
export const RETRY_MS = 30000;
async function loadDevices() {
  try {
    const ids = (await kvGet('push:index')) || [];
    for (const id of ids) { const d = await kvGet('push:dev:' + id); if (d) devices.set(id, d); }
    ready = true;
    pushState.enabled = true; pushState.reason = '';
    console.log(`[push] 已启用，设备 ${devices.size} 台`);
    let checking = false;   // 一次检查超过 30 秒时不叠加下一次（否则摘要可能重复发）
    setInterval(() => { if (checking) return; checking = true; check().catch(e => { pushState.lastError = e.message; }).finally(() => { checking = false; }); }, 30000).unref();
  } catch (e) {
    pushState.reason = `存储不可用：${e.message}`;
    console.log(`[push] 载入设备失败，${RETRY_MS / 1000} 秒后重试：${e.message}`);
    setTimeout(loadDevices, RETRY_MS);
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

export async function subscribe(sub, lang, userId = null, sid = null) {
  if (!ready) throw Object.assign(new Error(pushState.reason || 'push_disabled'), { code: 503 });
  if (!validSub(sub)) throw Object.assign(new Error('invalid_subscription'), { code: 400 });
  const id = devId(sub.endpoint);
  const old = devices.get(id);
  if (!old && devices.size >= MAX_DEVICES) throw Object.assign(new Error('too_many_devices'), { code: 429 });
  if (userId) return claimDevice(id, old, sub, lang, userId, sid);
  devices.set(id, { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, rules: old?.rules || [], lang: lang || 'zh', created: old?.created || Date.now(), digest: old?.digest, ...(old?.userId ? { userId: old.userId, sid: old.sid } : {}) });
  await saveDevice(id);
  if (!old) await saveIndex();
  return { id, rules: devices.get(id).rules };
}

// 账号模式下订阅 = 把这台设备绑到当前账号。第一次绑定时把设备上原有的规则、摘要复制进账号（按内容去重），设备上的原数据保留不删。
const ruleSig = r => JSON.stringify([r.stop?.agency, r.stop?.id, r.route, r.lead, r.days, r.from, r.to, r.once]);
async function claimDevice(id, old, sub, lang, userId, sid) {
  const keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };
  const same = old && old.userId === userId && old.sid === sid && old.lang === (lang || 'zh') && old.sub.keys.p256dh === keys.p256dh && old.sub.keys.auth === keys.auth;
  if (!same) {
    if (old && !old.userId) {   // 只认领从没绑过账号的设备的旧数据；换账号登录不把别人的规则带过来
      await updateData(userId, data => {
        const rules = [...(data.rules || [])], have = new Set(rules.map(ruleSig));
        for (const r of old.rules || []) if (rules.length < MAX_RULES && !have.has(ruleSig(r))) { rules.push({ ...r }); have.add(ruleSig(r)); }
        const digest = data.digest || (old.digest ? { ...old.digest } : null);
        return rules.length !== (data.rules || []).length || digest !== data.digest ? { ...data, rules, digest } : null;
      });
    }
    devices.set(id, { sub: { endpoint: sub.endpoint, keys }, rules: old?.rules || [], lang: lang || 'zh', created: old?.created || Date.now(), digest: old?.digest, userId, sid });
    await saveDevice(id);
    if (!old) await saveIndex();
  }
  return { id, rules: getData(userId).rules || [] };
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
  d.digest = applyDigest(d.digest, input);
  await saveDevice(id);
  return d.digest;
}
function applyDigest(old, input) {
  const dg = cleanDigest(input || {}, old);
  if (!dg) throw Object.assign(new Error('invalid_digest'), { code: 400 });
  // 改了时间或刚打开：今天已过点就从明天开始，免得一保存就推
  const t = torontoNow();
  if ((input?.at || input?.enabled) && t.hm > dg.at) dg.lastDate = t.date;
  return dg;
}

// 给 Mac 端提醒器（POST/GET /api/notify* 密钥鉴权）：所有启用摘要的时间，用来到点前叫醒本服务。不含站点和设备。
export function digestSchedule() {
  if (!ready) throw Object.assign(new Error(pushState.reason || 'push_disabled'), { code: 503 });
  if (acctMode && !acctState.ready) throw Object.assign(new Error('accounts_loading'), { code: 503 });   // 账号还没载入：别让 Mac 缓存一张空表
  const seen = new Map();
  for (const { digest: g } of targets()) {
    if (g?.enabled && g.stops?.length) seen.set(`${g.at}|${g.days.join(',')}`, { at: g.at, days: [...g.days] });
  }
  return [...seen.values()].sort((x, y) => (x.at + x.days).localeCompare(y.at + y.days));
}

// 只给计数，排查用：设备数、有摘要设置的、已开启的、已开启且有收藏站的
export function digestStats() {
  const all = targets().map(x => x.digest).filter(Boolean);
  return { devices: devices.size, digests: all.length, enabled: all.filter(g => g.enabled).length,
    ready: all.filter(g => g.enabled && g.stops?.length).length };
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
  for (const x of targets()) {
    const dg = x.digest;
    if (!digestDue(dg, t)) continue;
    const m = await digestPayload(dg);
    if (m.empty && !digestLastCall(dg, t)) continue; // 刚唤醒、实时数据还没到：下一轮再试
    if (await sendTo(x.devIds, { title: m.title, body: m.body, tag: 'digest', url: '/?tab=favs' }, 1800)) {
      await x.update(o => { if (o.digest) o.digest.lastDate = t.date; });
    }
  }
}

// rule: { stop:{agency,id,name}, route?:string, lead:分钟, days:[0-6], from:'HH:MM', to:'HH:MM', once:bool }
export async function addRule(id, r) {
  const d = devices.get(id);
  if (!d) throw Object.assign(new Error('unknown_device'), { code: 404 });
  if (d.rules.length >= MAX_RULES) throw Object.assign(new Error('too_many_rules'), { code: 429 });
  const rule = makeRule(r);
  d.rules.push(rule);
  await saveDevice(id);
  return rule;
}
function makeRule(r) {
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

// 发给一组设备，返回成功台数
async function sendTo(ids, payload, ttl) { let n = 0; for (const id of ids) if (await send(id, payload, ttl)) n++; return n; }

// 推送对象：没认领（或账号模式关闭）的设备 = 自己；账号模式下认领了的设备按账号合并，规则和摘要取账号的
function targets() {
  const out = [], byUser = new Map();
  for (const [id, d] of devices) {
    if (acctMode && d.userId) {
      // 绑定它的会话已失效（改密码、过期、在别处退出）：这台设备不再收这个账号的提醒，也不退回按设备推旧快照
      if (sessionAlive(d.userId, d.sid)) { if (!byUser.has(d.userId)) byUser.set(d.userId, []); byUser.get(d.userId).push(id); }
      continue;
    }
    out.push({ key: id, rules: d.rules, digest: d.digest, devIds: [id], lang: d.lang, update: async fn => { fn(d); await saveDevice(id); } });
  }
  for (const [uid, ids] of byUser) {
    const data = getData(uid);
    // 账号的修改基于最新数据（checkDigests / check 中间有 await，不能写回这里取到的旧副本）
    out.push({ key: 'u:' + uid, rules: data.rules || [], digest: data.digest, devIds: ids, lang: devices.get(ids[0]).lang,
      update: fn => updateData(uid, cur => { const next = structuredClone(cur); fn(next); return next; }) });
  }
  return out;
}

// ---------- 账号模式：按账号读写规则和摘要（index.js 在 req.user 存在时调用） ----------
const devsOf = uid => [...devices].filter(([, d]) => d.userId === uid && sessionAlive(uid, d.sid)).map(([id]) => id);
export const acctRules = uid => getData(uid).rules || [];
export async function acctAddRule(uid, r) {
  const rule = makeRule(r);
  await updateData(uid, data => {
    const rules = data.rules || [];
    if (rules.length >= MAX_RULES) throw Object.assign(new Error('too_many_rules'), { code: 429 });
    return { ...data, rules: [...rules, rule] };
  });
  return rule;
}
export async function acctDeleteRule(uid, ruleId) {
  await updateData(uid, data => ({ ...data, rules: (data.rules || []).filter(r => r.id !== ruleId) }));
}
export const acctGetDigest = uid => getData(uid).digest || null;
export async function acctSetDigest(uid, input) {
  // 账号模式下摘要站点总是取账号收藏（单一来源；保存收藏时 accounts.setFavs 也会同步）
  const next = await updateData(uid, data => {
    const stops = (data.favs || []).map(f => ({ agency: f.agency, id: f.id, name: f.name }));
    return { ...data, digest: applyDigest(data.digest, { ...(input || {}), stops }) };
  });
  return next.digest;
}
export async function acctUnsubscribe(uid, id) {
  if (devices.get(id)?.userId !== uid) throw Object.assign(new Error('unknown_device'), { code: 404 });
  await unsubscribe(id);
}
export async function acctSendTest(uid) {
  const ids = devsOf(uid);
  if (!ids.length) throw Object.assign(new Error('no_device'), { code: 404 });
  if (!await sendTo(ids, { title: 'GTA 公交实时', body: '测试通知：推送提醒已开通 ✅', tag: 'test' })) throw Object.assign(new Error(pushState.lastError || 'send_failed'), { code: 502 });
  return ids.length;
}
export async function acctSendDigestNow(uid) {
  const dg = getData(uid).digest, ids = devsOf(uid);
  if (!dg?.stops?.length) throw Object.assign(new Error('no_favorites'), { code: 400 });
  if (!ids.length) throw Object.assign(new Error('no_device'), { code: 404 });
  const m = await digestPayload(dg);
  if (!await sendTo(ids, { title: m.title, body: m.body, tag: 'digest', url: '/?tab=favs' }, 1800)) throw Object.assign(new Error(pushState.lastError || 'send_failed'), { code: 502 });
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
  // 账号模式下设了 NOTIFY_USER（用户名）：只发给这个账号的设备（Mac 的通勤提醒只给本人）
  let ids = [...devices.keys()];
  if (acctMode && process.env.NOTIFY_USER) {   // 指定了账号就只发给它；账号没载入或找不到时绝不退回发给所有人
    if (!acctState.ready) throw Object.assign(new Error('accounts_loading'), { code: 503 });
    const only = uidByName(process.env.NOTIFY_USER);
    if (!only) throw Object.assign(new Error('notify_user_not_found'), { code: 404 });
    ids = devsOf(only);
  }
  const sent = await sendTo(ids, { title, body, tag, url: '/' }, 1800);
  if (key && sent) notified.set(key, now);
  return { devices: ids.length, sent };
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
  for (const x of targets()) for (const r of x.rules) if (inWindow(r, t)) active.push([x, r]);
  if (!active.length) return; // 没有生效的规则就不拉任何数据
  const byStop = new Map();
  for (const [, r] of active) byStop.set(`${r.stop.agency}:${r.stop.id}`, r.stop);
  const arrivals = new Map();
  for (const [key, s] of byStop) {
    try { arrivals.set(key, await arrivalsFn(s.agency, s.id)); } catch { arrivals.set(key, []); }
  }
  const nowS = Math.floor(now / 1000);
  for (const [x, r] of active) {
    const list = arrivals.get(`${r.stop.agency}:${r.stop.id}`) || [];
    const hit = list.find(a => (!r.route || String(a.routeShort).toLowerCase() === r.route.toLowerCase())
      && a.time - nowS <= r.lead * 60 && a.time - nowS >= -30);
    if (!hit) continue;
    const key = `${x.key}:${r.id}:${hit.tripId || hit.time}`;
    if (fired.has(key)) continue;
    fired.set(key, now);
    const min = Math.max(0, Math.round((hit.time - nowS) / 60));
    const zh = x.lang !== 'en';
    const body = zh
      ? `${hit.routeShort} 路${hit.headsign ? `（${hit.headsign}）` : ''}${min <= 0 ? '即将到站' : ` ${min} 分钟后到站`}`
      : `Route ${hit.routeShort}${hit.headsign ? ` (${hit.headsign})` : ''} ${min <= 0 ? 'arriving now' : `in ${min} min`}`;
    await sendTo(x.devIds, { title: r.stop.name, body, tag: `r-${r.id}`, url: `/?stop=${encodeURIComponent(`${r.stop.agency}:${r.stop.id}`)}` });
    if (r.once) await x.update(o => { const rr = (o.rules || []).find(z => z.id === r.id); if (rr) rr.enabled = false; });   // 与原逻辑一致：尝试推过就停用
  }
}
