// 简单访问密码：设置环境变量 APP_PASSWORD 才启用；本地不设则全部放行。
// 登录后发 HttpOnly cookie：<过期时间>.<HMAC>，改密码即全部失效。
import crypto from 'node:crypto';
import { accountsOn, handleAccountAuth } from './auth-accounts.js';

const PASSWORD = process.env.APP_PASSWORD || '';
const COOKIE = 'gta_auth';
const MAX_AGE = 180 * 24 * 3600; // 秒
const SECRET = crypto.createHash('sha256').update('gta-auth-v1:' + PASSWORD).digest();
const PUBLIC = /^\/(login|logout|healthz|manifest\.webmanifest|sw\.js|icons\/.*)$/;
const fails = new Map(); // ip -> [时间戳...]

export const authEnabled = !!PASSWORD;

const sign = exp => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest();

function validCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, mac] = m[1].split('.');
  if (!exp || !mac || +exp < Date.now() / 1000) return false;
  const want = sign(exp);
  return mac.length === want.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
}

const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
const isHttps = req => req.headers['x-forwarded-proto'] === 'https';

function loginPage(msg = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0a66c2">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>GTA 公交实时 · 登录</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#eef2f6;font:16px -apple-system,"PingFang SC",system-ui,sans-serif}
form{background:#fff;padding:28px 24px;border-radius:14px;box-shadow:0 6px 24px #0002;width:min(320px,86vw)}
h1{font-size:19px;margin:0 0 4px}p{color:#666;font-size:13px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;font-size:16px;padding:11px 12px;border:1px solid #ccc;border-radius:8px}
button{margin-top:12px;width:100%;padding:11px;font-size:16px;border:0;border-radius:8px;background:#0a66c2;color:#fff}
.err{color:#c62828;font-size:13px;margin-top:10px}</style></head><body>
<form method="post" action="/login"><img src="/icons/icon-192.png" width="48" height="48" alt="" style="border-radius:11px">
<h1>GTA 公交实时</h1><p>请输入访问密码</p>
<input type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">进入</button>${msg ? `<div class="err">${msg}</div>` : ''}</form></body></html>`;
}

function html(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function readBody(req, limit = 4096) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > limit) break; }
  return data;
}

// 返回 true = 已处理（响应已发出）；false = 继续正常路由
export async function handleAuth(req, res, url) {
  if (accountsOn) return handleAccountAuth(req, res, url);   // 账号模式（ACCOUNTS=1 且配置齐全），见 auth-accounts.js
  if (!PASSWORD) return false;
  const p = url.pathname;

  if (p === '/logout') {
    html(res, 302, '', { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
    return true;
  }
  if (p === '/login') {
    if (req.method !== 'POST') { html(res, 200, loginPage()); return true; }
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (fails.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    if (recent.length >= 10) { html(res, 429, loginPage('尝试太多次，请 10 分钟后再试。')); return true; }
    const pw = new URLSearchParams(await readBody(req)).get('password') || '';
    if (!crypto.timingSafeEqual(sha(pw), sha(PASSWORD))) {
      recent.push(now); fails.set(ip, recent);
      html(res, 401, loginPage('密码不对。'));
      return true;
    }
    fails.delete(ip);
    const exp = Math.floor(now / 1000) + MAX_AGE;
    const cookie = `${COOKIE}=${exp}.${sign(exp)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
    html(res, 303, '', { location: '/', 'set-cookie': cookie });
    return true;
  }
  if (PUBLIC.test(p) || validCookie(req)) return false;

  if (p.startsWith('/api/') || !(req.headers.accept || '').includes('text/html')) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end('{"error":"login_required"}');
  } else {
    html(res, 302, '', { location: '/login' });
  }
  return true;
}
