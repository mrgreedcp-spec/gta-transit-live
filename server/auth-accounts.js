// 账号模式的登录 / 注册 / 会话校验。只在 ACCOUNTS=1 且 SESSION_SECRET（≥32 字符）、APP_PASSWORD（邀请码）、持久存储都齐全时启用；
// 否则 auth.js 走原来的共享密码逻辑，行为不变。
// 会话 cookie gta_sess 用独立的 SESSION_SECRET 签名：邀请码 = APP_PASSWORD，持有邀请码的人不能伪造别人的会话。
// 旧的 gta_auth cookie 在账号模式下不再放行（它能被任何持有邀请码的人伪造），跳登录页重新注册。
import crypto from 'node:crypto';
import { kvPersistent } from './kv.js';
import { clientKey } from './ratelimit.js';
import { acctState, setSessionSecret, parseSession, verifySession, register, login, logout, initAccounts } from './accounts.js';
import { growthOn, cleanRef, touch } from './growth.js';

const INVITE = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || '';
export const accountsWanted = process.env.ACCOUNTS === '1';
export const accountsOn = accountsWanted && SECRET.length >= 32 && !!INVITE && kvPersistent;
export const accountsWhyOff = !accountsWanted ? '' : SECRET.length < 32 ? '缺 SESSION_SECRET（至少 32 字符）' : !INVITE ? '缺 APP_PASSWORD（邀请码）' : !kvPersistent ? '没有持久存储（Upstash）' : '';
if (accountsOn) setSessionSecret(SECRET);

const COOKIE = 'gta_sess';
const PUBLIC = /^\/(login|logout|register|healthz|manifest\.webmanifest|sw\.js|icons\/.*)$/;
// 管理员重置过密码、还没改的账号：只能用这几个接口（页面和静态文件照常加载，前端显示改密码表单）
const MUST_OK = new Set(['/api/account/me', '/api/account/password', '/api/account/logout']);

export function startAccounts() { if (accountsOn) initAccounts(); }

// ---------- 小工具（与 auth.js 的同名函数分开写，旧文件不动） ----------
const isHttps = req => req.headers['x-forwarded-proto'] === 'https';
function cookieOf(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
export function sessionCookie(req, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}
export const clearCookies = [`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`, 'gta_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'];
function html(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function json(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
async function readForm(req, limit = 4096) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > limit) break; }
  return new URLSearchParams(data.slice(0, limit));
}
// 有 Origin 头且与本站不同：拒绝（防跨站提交）
export function badOrigin(req) {
  const o = req.headers.origin;
  if (!o || o === 'null') return !!o;
  try { return new URL(o).host !== req.headers.host; } catch { return true; }
}

// ---------- 限流（内存） ----------
const hits = new Map(); // key -> [时间戳...]
function over(key, max, winMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < winMs);
  hits.set(key, list);
  return list.length >= max;
}
const mark = key => { const l = hits.get(key) || []; l.push(Date.now()); hits.set(key, l); };
setInterval(() => { const now = Date.now(); for (const [k, l] of hits) if (!l.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const GLOBAL = ['auth:all', 60, 60e3];   // 全站每分钟最多 60 次登录/注册尝试（IP 头可能被伪造时兜底）

// ---------- 页面 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function accountPage({ msg = '', mode = 'login', name = '' } = {}) {
  const reg = mode === 'register';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0a66c2">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>GTA 公交实时 · ${reg ? '注册' : '登录'}</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#eef2f6;font:16px -apple-system,"PingFang SC",system-ui,sans-serif}
main{background:#fff;padding:28px 24px;border-radius:14px;box-shadow:0 6px 24px #0002;width:min(330px,88vw)}
h1{font-size:19px;margin:8px 0 4px}p{color:#666;font-size:13px;margin:0 0 14px;line-height:1.5}
label{display:block;font-size:13px;color:#444;margin:10px 0 4px}
input{width:100%;box-sizing:border-box;font-size:16px;padding:11px 12px;border:1px solid #ccc;border-radius:8px}
button{margin-top:16px;width:100%;padding:11px;font-size:16px;border:0;border-radius:8px;background:#0a66c2;color:#fff}
.err{color:#c62828;font-size:13px;margin-top:10px}.sw{margin-top:16px;font-size:14px;text-align:center}.sw a{color:#0a66c2}
form[hidden]{display:none}</style></head><body><main>
<img src="/icons/icon-192.png" width="48" height="48" alt="" style="border-radius:11px">
<h1>GTA 公交实时</h1>
<form method="post" action="/login" ${reg ? 'hidden' : ''}>
<p>用账号登录。以前用访问密码的，请先注册一个账号（访问密码就是邀请码）。</p>
<label for="lu">用户名</label><input id="lu" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value="${reg ? '' : esc(name)}" required>
<label for="lp">密码</label><input id="lp" type="password" name="password" autocomplete="current-password" required>
<button type="submit">登录</button>
<div class="sw">没有账号？<a href="/login?register=1">用邀请码注册</a></div>${process.env.ADMIN_USER ? '<div class="sw" style="color:#666;font-size:13px">忘记密码？请联系管理员重置。</div>' : ''}</form>
<form method="post" action="/register" ${reg ? '' : 'hidden'}>
<p>用户名 3–20 位小写字母、数字或下划线；密码至少 8 位。</p>
<label for="ri">邀请码</label><input id="ri" type="password" name="invite" autocomplete="off" required>
<label for="ru">用户名</label><input id="ru" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value="${reg ? esc(name) : ''}" required pattern="[A-Za-z0-9_]{3,20}">
<label for="rp">密码</label><input id="rp" type="password" name="password" autocomplete="new-password" minlength="8" required>
<button type="submit">注册并登录</button>
<div class="sw">已有账号？<a href="/login">去登录</a></div></form>
${msg ? `<div class="err">${esc(msg)}</div>` : ''}</main></body></html>`;
}

const REG_MSG = { bad_username: '用户名要 3–20 位小写字母、数字或下划线。', weak_password: '密码至少 8 位，且不能和用户名或邀请码相同。',
  name_taken: '这个用户名不能用，换一个。', full: '注册人数已满。', auth_unavailable: '服务正在启动，请稍后再试。' };

// 返回 true = 已处理（响应已发出）；false = 继续正常路由（已登录时 req.user 已设好）
export async function handleAccountAuth(req, res, url) {
  const p = url.pathname, ip = clientKey(req);
  // 渠道来源：带 ?ref= 打开页面时记 30 天（第一次来源优先，不覆盖）。302 到登录页、登录页本身都会带上这个 cookie
  if (growthOn() && req.method === 'GET' && !p.startsWith('/api/')) {
    const ref = cleanRef(url.searchParams.get('ref'));
    if (ref && !cleanRef(cookieOf(req, 'gta_ref'))) res.setHeader('set-cookie', `gta_ref=${ref}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
  }

  if (p === '/logout') {   // 旧链接 / 书签：顺便注销服务器上的这个会话
    // 只认本站内点击或直接打开；别的网站链过来的什么都不清，回首页（防止被远程强制登出）
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') { html(res, 302, '', { location: '/' }); return true; }
    const u = verifySession(cookieOf(req, COOKIE));
    if (u) await logout(u.id, u.sid).catch(() => {});
    html(res, 302, '', { location: '/login', 'set-cookie': clearCookies }); return true;
  }

  if ((p === '/login' || p === '/register') && req.method === 'POST') {
    if (badOrigin(req)) { html(res, 403, accountPage({ msg: '请求来源不对。' })); return true; }
    const reg = p === '/register';
    const f = await readForm(req);
    const name = String(f.get('username') || '').slice(0, 40);
    const page = (code, msg) => html(res, code, accountPage({ msg, mode: reg ? 'register' : 'login', name }));
    if (!acctState.ready) { page(503, '服务正在启动，请稍后再试。'); return true; }
    const nameKey = 'auth:name:' + name.normalize('NFKC').trim().toLowerCase();
    if (over(...GLOBAL) || over('auth:ip:' + ip, 10, 600e3) || (reg ? over('auth:reg:' + ip, 5, 3600e3) : over(nameKey, 10, 600e3))) {
      page(429, '尝试太多次，请 10 分钟后再试。'); return true;
    }
    mark(GLOBAL[0]);
    if (reg) {
      mark('auth:reg:' + ip);
      const invite = String(f.get('invite') || '');
      const a = crypto.createHash('sha256').update(invite).digest(), b = crypto.createHash('sha256').update(INVITE).digest();
      if (!crypto.timingSafeEqual(a, b)) { mark('auth:ip:' + ip); page(401, '邀请码不对。'); return true; }
      try {
        const s = await register({ name, password: String(f.get('password') || ''), invite, ref: growthOn() ? cleanRef(cookieOf(req, 'gta_ref')) : null });
        html(res, 303, '', { location: process.env.SEO_GUIDE === '1' ? '/live' : '/', 'set-cookie': sessionCookie(req, s.cookie, s.maxAge) });
      } catch (e) { page(e.code || 500, REG_MSG[e.message] || '注册失败，请稍后再试。'); }
      return true;
    }
    let s = null;
    try { s = await login(name, String(f.get('password') || '')); }
    catch (e) { page(e.code || 500, REG_MSG[e.message] || '登录失败，请稍后再试。'); return true; }
    if (!s) { mark('auth:ip:' + ip); mark(nameKey); page(401, '用户名或密码不对。'); return true; }
    html(res, 303, '', { location: process.env.SEO_GUIDE === '1' ? '/live' : '/', 'set-cookie': sessionCookie(req, s.cookie, s.maxAge) });
    return true;
  }
  if (p === '/login' || p === '/register') {
    html(res, 200, accountPage({ mode: url.searchParams.get('register') === '1' || p === '/register' ? 'register' : 'login' }));
    return true;
  }
  if (PUBLIC.test(p)) return false;

  const raw = cookieOf(req, COOKIE);
  const user = verifySession(raw);
  if (user) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && badOrigin(req)) { json(res, 403, { error: 'bad_origin' }); return true; }
    if (user.mustChange && p.startsWith('/api/') && !MUST_OK.has(p)) { json(res, 403, { error: 'must_change_password' }); return true; }
    touch(user.id);   // 活跃度：只记内存
    req.user = user;
    return false;
  }
  // cookie 签名有效但账号还没载入（冷启动、Upstash 超时）：回 503，不要把人踢回登录页
  if (!acctState.ready && parseSession(raw)) {
    if (p.startsWith('/api/') || !(req.headers.accept || '').includes('text/html')) json(res, 503, { error: 'auth_unavailable' });
    else html(res, 503, accountPage({ msg: '服务正在启动，几秒后刷新一下。' }), { 'retry-after': '5' });
    return true;
  }
  if (p.startsWith('/api/') || !(req.headers.accept || '').includes('text/html')) json(res, 401, { error: 'login_required' });
  else html(res, 302, '', { location: '/login' });
  return true;
}
