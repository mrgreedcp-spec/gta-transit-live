// 账号：用户、会话、账号数据。启动时全量载入内存，写操作先写 KV 再改内存；请求路径只读内存（不打 Upstash）。
// 只在 ACCOUNTS=1 且配置齐全时由 auth-accounts.js 启用。假设：Render 单实例单进程（用户名唯一性靠进程内占位）。
// Key（kv.js 自动加 gta: 前缀）：
//   acct:index        = [uid...]
//   acct:user:<uid>   = { id, name, pw:{ salt, hash, N, r, p }, created, sessions:[{ sid, exp, at }], mustChange? }
//                       mustChange: 管理员重置过密码，用户改好前只能改密码或登出（旧记录没有这个字段 = false）
//   acct:data:<uid>   = { favs:[...], rev, rules:[...], digest }   首次写入时才创建
import crypto from 'node:crypto';
import { kvGet, kvSet, kvDel } from './kv.js';

export const MAX_USERS = Math.max(1, +process.env.MAX_USERS || 50);
const MAX_SESSIONS = 10, SESSION_S = 180 * 24 * 3600, MAX_FAVS = 100;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };   // Node 24 默认 maxmem 不够，必须显式给
const err = (msg, code) => Object.assign(new Error(msg), { code });

const users = new Map();   // uid -> 用户记录（含密码哈希，不要直接返回给前端）
const byName = new Map();  // 规范化用户名 -> uid
const datas = new Map();   // uid -> 账号数据
const pending = new Set(); // 注册中占位的用户名
const renaming = new Set(); // 改名中占位的用户名（单独一个集合：注册按 users + pending 判满，不能混用）
export const acctState = { ready: false, reason: '未载入', users: 0 };

let KEY = null;
export function setSessionSecret(s) { KEY = crypto.createHash('sha256').update('gta-sess-v1:' + s).digest(); }

// ---------- 用户名、密码 ----------
export function normalizeName(s) {
  const n = String(s ?? '').normalize('NFKC').trim().toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(n) ? n : null;
}
export const passwordOk = (pw, name, invite) => typeof pw === 'string' && pw.length >= 8 && pw.length <= 128
  && pw.toLowerCase() !== String(name || '').toLowerCase() && pw !== invite;

// scrypt 很吃内存（N=32768 约 32 MB），同时最多跑 2 个，其余排队
let running = 0; const waiting = [];
async function scrypt(pw, salt, params) {
  if (running >= 2) await new Promise(r => waiting.push(r)); else running++;
  try {
    return await new Promise((res, rej) => crypto.scrypt(String(pw).normalize('NFKC'), salt, 32,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem }, (e, k) => e ? rej(e) : res(k)));
  } finally { const next = waiting.shift(); if (next) next(); else running--; }
}
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
}
export async function verifyPassword(pw, rec) {
  const got = await scrypt(pw, Buffer.from(rec.salt, 'base64'), rec);
  const want = Buffer.from(rec.hash, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_SALT = Buffer.alloc(16, 7);

// ---------- 会话 cookie：v1.<uid>.<sid>.<exp>.<mac> ----------
const mac = s => crypto.createHmac('sha256', KEY).update(s).digest('base64url');
const rand = () => crypto.randomBytes(12).toString('base64url');
export function signSession(uid, sid, exp) { const s = `v1.${uid}.${sid}.${exp}`; return `${s}.${mac(s)}`; }

// 只验签名和过期（不查内存）：用于区分「cookie 本身有效但服务还没载入」
export function parseSession(v) {
  if (!KEY || typeof v !== 'string') return null;
  const parts = v.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, uid, sid, exp, m] = parts;
  if (!/^\d+$/.test(exp) || +exp < Date.now() / 1000) return null;
  const want = mac(`v1.${uid}.${sid}.${exp}`);
  const a = Buffer.from(m), b = Buffer.from(want);   // 按字节比较：非 ASCII 字符不会让 timingSafeEqual 抛错
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { uid, sid, exp: +exp };
}
export function verifySession(v) {
  const s = parseSession(v);
  if (!s || !acctState.ready) return null;
  const u = users.get(s.uid);
  const now = Date.now() / 1000;
  if (!u || !u.sessions.some(x => x.sid === s.sid && x.exp > now)) return null;
  return { id: u.id, name: u.name, sid: s.sid, ...(u.mustChange ? { mustChange: true } : {}) };
}

// ---------- 载入 ----------
const RETRY = [3000, 10000, 30000];
export async function initAccounts(attempt = 0) {
  try {
    const ids = (await kvGet('acct:index')) || [];
    const us = new Map(), ds = new Map();
    for (const id of ids) {
      const u = await kvGet('acct:user:' + id);
      if (!u) continue;
      us.set(id, u);
      const d = await kvGet('acct:data:' + id);
      if (d) ds.set(id, d);
    }
    users.clear(); byName.clear(); datas.clear();
    for (const [id, u] of us) { users.set(id, u); byName.set(u.name, id); }
    for (const [id, d] of ds) datas.set(id, d);
    Object.assign(acctState, { ready: true, reason: '', users: users.size });
    console.log(`[accounts] 已载入 ${users.size} 个账号`);
    adminUid = byName.get(adminName()) || null;   // 只认启动时已经存在的账号：之后才注册这个名字的人拿不到管理权限
    if (adminName() && !adminUid) console.warn(`[accounts] ADMIN_USER=${adminName()} 还没注册，管理功能未启用：注册这个账号后重启服务才生效`);
  } catch (e) {
    const wait = RETRY[Math.min(attempt, RETRY.length - 1)];
    acctState.reason = `存储不可用：${e.message}`;
    console.log(`[accounts] 载入失败，${wait / 1000} 秒后重试：${e.message}`);
    setTimeout(() => initAccounts(attempt + 1), wait).unref?.();
  }
}
const needReady = () => { if (!acctState.ready) throw err('auth_unavailable', 503); };

// 同一个用户的写操作排队执行，每次都基于最新记录改（避免「读→await→写回旧副本」覆盖别人的改动）
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// ---------- 会话增删 ----------
async function saveUser(u) { await kvSet('acct:user:' + u.id, u); users.set(u.id, u); }
// 在锁内基于最新记录加一个会话。expectHash：调用方验证过的密码哈希；最新记录的密码已经变了就放弃（返回 null）
function newSession(uid, { expectHash = null, keepOthers = true, pw = null, plain = null } = {}) {
  return withLock('u:' + uid, async () => {
    const u = users.get(uid);
    if (!u || (expectHash && u.pw.hash !== expectHash)) return null;
    if (plain && plain.toLowerCase() === u.name) throw err('weak_password', 400);   // 期间改了名：新密码不能等于最新的用户名
    const now = Math.floor(Date.now() / 1000), sid = rand(), exp = now + SESSION_S;
    const sessions = [...(keepOthers ? u.sessions.filter(x => x.exp > now) : []), { sid, exp, at: now }].slice(-MAX_SESSIONS);
    const { mustChange, ...rest } = u;   // 换了密码就清掉「必须改密码」
    await saveUser({ ...(pw ? rest : u), ...(pw ? { pw } : {}), sessions });
    return { cookie: signSession(u.id, sid, exp), maxAge: SESSION_S, user: { id: u.id, name: u.name } };
  });
}

export async function register({ name: raw, password, invite }) {
  needReady();
  const name = normalizeName(raw);
  if (!name) throw err('bad_username', 400);
  if (!passwordOk(password, name, invite)) throw err('weak_password', 400);
  if (byName.has(name) || pending.has(name) || renaming.has(name)) throw err('name_taken', 409);
  if (users.size + pending.size >= MAX_USERS) throw err('full', 403);
  pending.add(name);
  try {
    const pw = await hashPassword(password);
    const id = rand();
    const u = { id, name, pw, created: Date.now(), sessions: [] };
    await kvSet('acct:user:' + id, u);
    await withLock('index', async () => {   // 并发注册时索引按顺序写，每次都包含已注册的全部用户
      try { await kvSet('acct:index', [...users.keys(), id]); }
      catch (e) { await kvDel('acct:user:' + id).catch(() => {}); throw err('auth_unavailable', 503); }
      users.set(id, u); byName.set(name, id); acctState.users = users.size;
    });
    return await newSession(id);
  } finally { pending.delete(name); }
}

// 返回 null = 用户名或密码不对（两种情况耗时、返回都一样）
export async function login(raw, password) {
  needReady();
  const name = normalizeName(raw);
  const u = name && users.get(byName.get(name));
  if (!u || typeof password !== 'string' || password.length > 128) {
    await scrypt(String(password ?? '').slice(0, 128), DUMMY_SALT, SCRYPT);
    return null;
  }
  if (!await verifyPassword(password, u.pw)) return null;
  return newSession(u.id, { expectHash: u.pw.hash });   // 验证期间密码被改了：按失败处理
}

export function logout(uid, sid) {
  return withLock('u:' + uid, async () => {
    const u = users.get(uid);
    if (!u) return;
    users.set(uid, { ...u, sessions: u.sessions.filter(x => x.sid !== sid) });   // 先在内存里注销：即使 KV 写失败，这个 cookie 立刻失效
    for (let i = 0; i < 2; i++) {
      try { await kvSet('acct:user:' + uid, users.get(uid)); return; }
      catch (e) { if (i) console.warn('[accounts] 登出写入失败，重启后该会话可能恢复', e.message); }
    }
  });
}

export async function changePassword(uid, oldPw, newPw, invite) {
  needReady();
  const u = users.get(uid);
  if (!u) throw err('login_required', 401);
  if (typeof oldPw !== 'string' || oldPw.length > 128 || !await verifyPassword(oldPw, u.pw)) throw err('bad_password', 401);
  if (!passwordOk(newPw, u.name, invite)) throw err('weak_password', 400);
  if (u.mustChange && await verifyPassword(newPw, u.pw)) throw err('weak_password', 400);   // 临时密码（含全角等写法）管理员知道，不能沿用
  const pw = await hashPassword(newPw);
  const s = await newSession(uid, { expectHash: u.pw.hash, keepOthers: false, pw, plain: newPw });   // 其他设备全部下线，当前设备换新 cookie
  if (!s) throw err('bad_password', 409);   // 期间密码已被别处改过
  return s;
}

// ---------- 管理员、改名、重置密码 ----------
// ADMIN_USER / NOTIFY_USER 按用户名配置：这两个账号不能改名，别人也不能改成这两个名字（防止冒名拿到权限）
const adminName = () => normalizeName(process.env.ADMIN_USER || '');
const reservedNames = () => new Set([adminName(), normalizeName(process.env.NOTIFY_USER || '')].filter(Boolean));
let adminUid = null;   // initAccounts 载入时确定
export const isAdmin = uid => { const a = adminName(); return !!a && !!uid && uid === adminUid && users.get(uid)?.name === a; };

export async function renameUser(uid, rawName, password) {
  needReady();
  const name = normalizeName(rawName);
  if (!name) throw err('bad_username', 400);
  const u = users.get(uid);
  if (!u) throw err('login_required', 401);
  if (reservedNames().has(u.name)) throw err('name_locked', 403);
  if (name === u.name) throw err('same_name', 400);
  if (typeof password !== 'string' || password.length > 128 || !await verifyPassword(password, u.pw)) throw err('bad_password', 401);
  if (password.toLowerCase() === name) throw err('weak_password', 400);
  // 下面三步同步执行（中间没有 await），并发抢同一个名字只有一个能占到
  if (reservedNames().has(name) || byName.has(name) || pending.has(name) || renaming.has(name)) throw err('name_taken', 409);
  renaming.add(name);
  try {
    return await withLock('u:' + uid, async () => {
      const cur = users.get(uid);
      if (!cur || cur.pw.hash !== u.pw.hash) throw err('bad_password', 409);   // 期间密码被改或被重置
      if (reservedNames().has(cur.name)) throw err('name_locked', 403);
      const next = { ...cur, name };
      await kvSet('acct:user:' + uid, next);
      users.set(uid, next); byName.delete(cur.name); byName.set(name, uid);
      return { id: uid, name };
    });
  } finally { renaming.delete(name); }
}

export function adminList(actorUid) {
  if (!isAdmin(actorUid)) throw err('not found', 404);
  const now = Date.now() / 1000;
  return { count: users.size, max: MAX_USERS, users: [...users.values()].map(u => ({
    id: u.id, name: u.name, created: u.created, sessions: u.sessions.filter(x => x.exp > now).length,
    mustChange: !!u.mustChange, self: u.id === actorUid })) };
}

// 临时密码：16 位，去掉 0 o 1 i l，按 4 位一组（约 79 bit）
const TEMP_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const tempPassword = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => TEMP_ABC[crypto.randomInt(TEMP_ABC.length)]).join('')).join('-');
export async function adminResetPassword(actorUid, targetUid) {
  needReady();
  if (!isAdmin(actorUid)) throw err('not found', 404);
  if (targetUid === actorUid) throw err('cannot_reset_self', 400);
  if (!users.has(targetUid)) throw err('user_not_found', 404);
  const temp = tempPassword();
  const pw = await hashPassword(temp);
  const name = await withLock('u:' + targetUid, async () => {
    const cur = users.get(targetUid);
    if (!cur) throw err('user_not_found', 404);
    await saveUser({ ...cur, pw, mustChange: true, sessions: [] });   // 所有会话下线；推送设备随会话失效
    return cur.name;
  });
  console.log(`[accounts] 管理员 ${users.get(actorUid)?.name} 重置了 ${name} 的密码`);
  return { name, tempPassword: temp };
}

// 这个会话还有效吗（推送用：设备绑定时记下会话，会话失效后设备不再收这个账号的提醒）
export function sessionAlive(uid, sid) {
  const now = Date.now() / 1000;
  return !!users.get(uid)?.sessions.some(x => x.sid === sid && x.exp > now);
}
export const userCount = () => users.size;
export const userIds = () => [...users.keys()];
export const userById = id => { const u = users.get(id); return u ? { id: u.id, name: u.name } : null; };
export const uidByName = name => byName.get(normalizeName(name)) || null;

// ---------- 账号数据 ----------
const emptyData = () => ({ favs: [], rev: 0, rules: [], digest: null });
export const getData = uid => datas.get(uid) || emptyData();
export async function saveData(uid, d) { await kvSet('acct:data:' + uid, d); datas.set(uid, d); }
// 基于最新数据修改并保存；fn 返回新对象（返回 null 表示不改）。同一用户的修改排队，不会互相覆盖
export function updateData(uid, fn) {
  return withLock('d:' + uid, async () => {
    const next = await fn(getData(uid));
    if (next) await saveData(uid, next);
    return next;
  });
}

const cleanFav = f => {
  const s = { agency: String(f?.agency || '').slice(0, 20), id: String(f?.id || '').slice(0, 40), name: String(f?.name || '').slice(0, 80) };
  if (f?.code != null) s.code = String(f.code).slice(0, 40);
  if (Number.isFinite(+f?.lat) && Number.isFinite(+f?.lon) && f.lat !== null && f.lon !== null) { s.lat = +f.lat; s.lon = +f.lon; }
  return s;
};
export function getFavs(uid) { const d = getData(uid); return { favs: d.favs, rev: d.rev }; }
export async function setFavs(uid, favs, base) {
  needReady();
  if (!Array.isArray(favs)) throw err('invalid_favs', 400);
  const next = await updateData(uid, d => {
    if (base !== d.rev) throw Object.assign(err('conflict', 409), { body: { favs: d.favs, rev: d.rev } });
    const seen = new Set(), list = [];
    for (const f of favs.map(cleanFav)) {
      const k = `${f.agency}:${f.id}`;
      if (!f.agency || !f.id || seen.has(k)) continue;
      seen.add(k); list.push(f);
      if (list.length >= MAX_FAVS) break;
    }
    const n = { ...d, favs: list, rev: d.rev + 1 };
    if (n.digest) n.digest = { ...n.digest, stops: list.map(f => ({ agency: f.agency, id: f.id, name: f.name })) };
    return n;
  });
  return { favs: next.favs, rev: next.rev };
}

// 测试用
export const _user = id => users.get(id);
export function _reset() { users.clear(); byName.clear(); datas.clear(); pending.clear(); renaming.clear(); adminUid = null; Object.assign(acctState, { ready: false, reason: '未载入', users: 0 }); }
