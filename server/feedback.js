// 用户反馈：App 里点「反馈」提交，存在 KV 键 feedback:list（最新在前，最多 500 条），管理员在 /admin 查看。
// - 旧模式（共享访问密码）和账号模式都能提交；只有账号模式的管理员能看（旧模式只能在 Upstash 控制台看 gta:feedback:list）。
// - 不存 IP、UA；IP 只在内存里用来限流（每 IP 每小时 5 条，全站每小时 60 条兜底）。
// - 写入串行，并且每次都先重读 KV 再写：启动时载入失败也不会用空列表盖掉历史；部署时新旧实例并存，
//   两边恰好同时提交才可能丢一条（窗口很小）。
// - 列表总大小上限 300KB（每次提交整表读写一次，控制 Upstash 流量）。管理员查看直接读 KV。
// - FEEDBACK=0 关闭；没有持久存储（重启就丢）时也自动关闭。
import crypto from 'node:crypto';
import { kvGet, kvSet, kvPersistent } from './kv.js';
import { isAdmin } from './accounts.js';

const KEY = 'feedback:list';
const MAX_ITEMS = 500, MAX_BYTES = 300 * 1024, MAX_TEXT = 1000, MAX_CONTACT = 100;
const PER_IP = 5, GLOBAL_MAX = 60, WINDOW_MS = 3600e3;
const TABS = new Set(['plan', 'near', 'favs', 'stop', 'veh', 'status']);
const err = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export const feedbackOn = () => process.env.FEEDBACK !== '0' && kvPersistent;

let list = [], loaded = false, chain = Promise.resolve();
export const feedbackLoaded = () => loaded;
export async function loadFeedback() {
  try { const v = await kvGet(KEY); list = Array.isArray(v) ? v : []; loaded = true; }
  catch (e) { console.warn('[feedback] 载入失败：', e.message); }
}

// 校验并清洗。不合法抛 400
export function cleanFeedback(body = {}) {
  if (typeof body.text !== 'string') throw err('text_required', 400);
  // 统一换行，去掉换行和制表符以外的控制字符
  const text = body.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!text) throw err('text_required', 400);
  if (text.length > MAX_TEXT) throw err('too_long', 400);
  const contact = (typeof body.contact === 'string' ? body.contact : '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (contact.length > MAX_CONTACT) throw err('too_long', 400);
  const c = body.ctx && typeof body.ctx === 'object' ? body.ctx : {};
  const w = Number(c.w);
  const ctx = {
    tab: TABS.has(c.tab) ? c.tab : '',
    ver: typeof c.ver === 'string' && /^v\d{1,4}$/.test(c.ver) ? c.ver : '',
    standalone: c.standalone === true,
    w: Number.isFinite(w) ? Math.min(10000, Math.max(0, Math.round(w))) : 0,
  };
  return { text, contact, ctx };
}

// 滑动窗口限流（内存）。key -> 时间戳数组
const hits = new Map();
const recent = (key, now) => (hits.get(key) || []).filter(t => now - t < WINDOW_MS);
function take(ip, now) {
  const mine = recent('ip:' + ip, now), all = recent('all', now);
  if (mine.length >= PER_IP || all.length >= GLOBAL_MAX) {
    const oldest = mine.length >= PER_IP ? mine[0] : all[0];
    throw err('rate_limited', 429, { retryAfter: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) });
  }
  mine.push(now); all.push(now);
  hits.set('ip:' + ip, mine); hits.set('all', all);
  return () => {   // 写入失败时把这次计数退回去
    for (const k of ['ip:' + ip, 'all']) { const l = hits.get(k) || [], i = l.lastIndexOf(now); if (i >= 0) l.splice(i, 1); }
  };
}
setInterval(() => { const now = Date.now(); for (const [k, l] of hits) { const r = l.filter(t => now - t < WINDOW_MS); if (r.length) hits.set(k, r); else hits.delete(k); } }, 600e3).unref();

export async function addFeedback({ text, contact, ctx, user = null, ip = '' } = {}, now = Date.now()) {
  if (!feedbackOn()) throw err('not found', 404);
  const clean = cleanFeedback({ text, contact, ctx });
  const undo = take(String(ip), now);   // 在第一个 await 之前记数：同一 IP 并发提交也挡得住
  const item = { id: `${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`, at: now, ...clean, ...(user ? { user: String(user).slice(0, 40) } : {}) };
  const run = chain.then(async () => {
    let cur;
    try { cur = await kvGet(KEY); } catch { throw err('storage_unavailable', 503); }
    const next = [];
    let bytes = 0;
    for (const x of [item, ...(Array.isArray(cur) ? cur : [])].slice(0, MAX_ITEMS)) {   // 超过总大小就丢最旧的
      bytes += Buffer.byteLength(JSON.stringify(x));
      if (bytes > MAX_BYTES && next.length) break;
      next.push(x);
    }
    try { await kvSet(KEY, next); } catch { throw err('storage_unavailable', 503); }
    list = next; loaded = true;
  });
  chain = run.catch(() => {});
  try { await run; } catch (e) { undo(); throw e; }
  return { ok: true, id: item.id };
}

// 管理员查看：直接读 KV（只给管理员、不轮询），读不到就 503，不把故障显示成「没有反馈」
export async function feedbackList(actorUid, limit = 200) {
  if (!isAdmin(actorUid)) throw err('not found', 404);
  let cur;
  try { cur = await kvGet(KEY); } catch { throw err('storage_unavailable', 503); }
  list = Array.isArray(cur) ? cur : []; loaded = true;
  return { total: list.length, items: list.slice(0, limit) };
}

// 测试用
export function _resetFeedback() { list = []; loaded = false; chain = Promise.resolve(); hits.clear(); }
