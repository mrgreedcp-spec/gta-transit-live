// 获客 / 增长仪表盘（管理员专用）。只在账号模式 + ADMIN_USER 时由 index.js 启用；默认关闭，旧模式完全不碰。
// - 渠道：带 ?ref=<渠道> 访问时记一个 30 天 cookie（首次来源优先），注册时写进用户记录 ref。
// - 活跃：已登录请求只在内存里记 uid 的当天日期（请求路径零 KV）；每 10 分钟把变化批量写入
//   acct:seen = { uid: 'YYYY-MM-DD' }（最后活跃日）和 acct:dau = { 'YYYY-MM-DD': 当天活跃账号数 }（留 90 天）。
// - 统计：buildGrowth 是纯函数，只读内存。不返回用户名、uid、密码等。
// 日期一律按 America/Toronto。
import { kvGet, kvSet } from './kv.js';
import * as kv from './kv.js';   // kvFlush 用命名空间取：测试里的 kv 替身没有它也不报错
import { isAdmin, growthUsers, MAX_USERS } from './accounts.js';

const REF_RE = /^[a-z0-9_-]{1,20}$/;
export const cleanRef = v => (typeof v === 'string' && REF_RE.test(v) ? v : null);

const FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
export const torontoDate = (ms = Date.now()) => FMT.format(new Date(ms));   // en-CA 格式就是 YYYY-MM-DD

// 以 today 结尾的 n 个日历日（旧到新）。按日历逐日减，不用 now - n*24h（夏令时那天不是 24 小时）
export function lastDays(today, n) {
  const [y, m, d] = today.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

const DAU_KEEP = 90;
let on = false, loaded = false, dirty = false, flushing = false, timer = null;
let seen = new Map();             // uid -> 最后活跃日
let dau = {};                     // date -> 当天活跃账号数
let day = { date: null, uids: new Set() };   // 今天活跃的 uid（跨午夜时定格进 dau）

export const growthOn = () => on;

function roll(today) {
  if (day.date === today) return;
  if (day.date) dau[day.date] = Math.max(dau[day.date] || 0, day.uids.size);
  day = { date: today, uids: new Set() };
  dirty = true;
}

// 请求路径调用：同步、只改内存
export function touch(uid, now = Date.now()) {
  if (!on || !uid) return;
  const today = torontoDate(now);
  roll(today);
  if (!day.uids.has(uid)) { day.uids.add(uid); dirty = true; }
  if (seen.get(uid) !== today) { seen.set(uid, today); dirty = true; }
}

export async function loadGrowth(now = Date.now()) {
  try {
    const s = (await kvGet('acct:seen')) || {}, d = (await kvGet('acct:dau')) || {};
    for (const [uid, date] of Object.entries(s)) if (!seen.has(uid) || seen.get(uid) < date) seen.set(uid, date);
    for (const [date, n] of Object.entries(d)) dau[date] = Math.max(dau[date] || 0, +n || 0);
    const today = torontoDate(now);
    roll(today);
    for (const [uid, date] of seen) if (date === today) day.uids.add(uid);
    loaded = true;
  } catch (e) { console.warn('[growth] 载入活跃数据失败，稍后重试：', e.message); }
}

export async function flushSeen(now = Date.now()) {
  if (!on || flushing) return;
  flushing = true;
  try {
    if (!loaded) await loadGrowth(now);
    if (!loaded) return;   // 没载入成功：绝不写，免得覆盖存储里的历史
    const today = torontoDate(now);
    roll(today);
    dau[today] = Math.max(dau[today] || 0, day.uids.size);
    const keep = new Set(lastDays(today, DAU_KEEP));
    for (const k of Object.keys(dau)) if (!keep.has(k)) { delete dau[k]; dirty = true; }
    if (!dirty) return;
    dirty = false;
    try {
      await kvSet('acct:seen', Object.fromEntries(seen));
      await kvSet('acct:dau', { ...dau });
    } catch (e) { dirty = true; console.warn('[growth] 写入活跃数据失败，下次重试：', e.message); }
  } finally { flushing = false; }
}

export async function startGrowth({ timer: useTimer = true, now = Date.now() } = {}) {
  on = true;
  await loadGrowth(now);
  if (useTimer && !timer) {
    timer = setInterval(() => flushSeen().catch(() => {}), 600e3); timer.unref?.();
    // Render 部署、休眠、重启前会发 SIGTERM：先把内存里的活跃记录写掉再退出（最多等 5 秒）
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => {
      const bye = () => process.exit(0);
      setTimeout(bye, 5000).unref();
      console.log(`[growth] 收到 ${sig}，写入活跃数据后退出`);
      flushSeen().catch(() => {}).then(() => kv.kvFlush?.()).catch(() => {}).finally(bye);
    });
  }
}

// 纯函数：把内存数据算成接口返回的 JSON
export function buildGrowth({ users, seen: seenMap, dau: dauMap, todaySet, pushUids = {}, max, now = Date.now() }) {
  const today = torontoDate(now);
  const d30 = lastDays(today, 30), d7 = new Set(lastDays(today, 7)), d30s = new Set(d30);
  const created = users.map(u => ({ ...u, date: torontoDate(u.created) }));
  const byDate = {};
  for (const u of created) byDate[u.date] = (byDate[u.date] || 0) + 1;
  let total = created.filter(u => u.date < d30[0]).length;
  const signups = d30.map(date => { total += byDate[date] || 0; return { date, n: byDate[date] || 0, total }; });
  const activated = u => u.favs > 0 || (pushUids[u.id] || 0) > 0;
  const ch = new Map();
  for (const u of created) {
    const k = u.ref || null, c = ch.get(k) || { ref: k, signups: 0, activated: 0 };
    c.signups++; if (activated(u)) c.activated++;
    ch.set(k, c);
  }
  const ids = new Set(users.map(u => u.id));
  const lastSeen = [...seenMap].filter(([uid]) => ids.has(uid)).map(([, date]) => date);
  const dates = Object.keys(dauMap).sort();
  const first = dates[0] && dates[0] < today ? dates[0] : today;   // 开始统计之前的日子是「没有数据」，不是 0
  return {
    today, tz: 'America/Toronto', since: dates[0] || null,
    accounts: { total: users.length, max, new7: created.filter(u => d7.has(u.date)).length, new30: created.filter(u => d30s.has(u.date)).length },
    signups,
    active: { today: [...todaySet].filter(uid => ids.has(uid)).length, d7: lastSeen.filter(d => d7.has(d)).length, d30: lastSeen.filter(d => d30s.has(d)).length },
    dau: d30.map(date => ({ date, n: date < first ? null : date === today ? Math.max(dauMap[date] || 0, todaySet.size) : dauMap[date] || 0 })),
    channels: [...ch.values()].sort((a, b) => b.signups - a.signups || (a.ref === null) - (b.ref === null) || String(a.ref).localeCompare(String(b.ref))),   // 同数时「未知」排最后
    activation: { withFavs: users.filter(u => u.favs > 0).length, withPush: users.filter(u => (pushUids[u.id] || 0) > 0).length, activated: users.filter(activated).length },
  };
}

export function growthStats(actorUid, pushUids = {}, now = Date.now()) {
  if (!isAdmin(actorUid)) throw Object.assign(new Error('not found'), { code: 404 });
  roll(torontoDate(now));
  return buildGrowth({ users: growthUsers(), seen, dau, todaySet: day.uids, pushUids, max: MAX_USERS, now });
}

// /admin 页面文件（放在仓库 admin/ 目录，不在 public/ 里，路径技巧够不到）：只给管理员，精确匹配
const ASSETS = { '/admin': 'admin.html', '/admin.js': 'admin.js' };
export const adminAsset = (pathname, uid) => (Object.hasOwn(ASSETS, pathname) && isAdmin(uid) ? ASSETS[pathname] : null);

// 测试用
export function _resetGrowth() {
  on = false; loaded = false; dirty = false; flushing = false;
  if (timer) clearInterval(timer); timer = null;
  seen = new Map(); dau = {}; day = { date: null, uids: new Set() };
}
export const _growthState = () => ({ seen, dau, day, dirty, loaded });
