// 特征测试：共享访问密码（旧模式）的行为。加账号系统前先跑绿，之后不改一行仍须全绿。
// ACCOUNTS 不设（或缺 SESSION_SECRET）时，handleAuth 必须与改动前逐字一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.APP_PASSWORD = 'pw-legacy';
delete process.env.SESSION_SECRET;
process.env.ACCOUNTS = '1';   // 开了开关但缺 SESSION_SECRET：必须仍走旧逻辑
const { handleAuth } = await import('../server/auth.js');

export function fakeReq({ method = 'GET', path = '/', headers = {}, body = '', ip = '1.2.3.4' } = {}) {
  const req = { method, url: path, headers: { ...headers }, socket: { remoteAddress: ip },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
  return req;
}
export function fakeRes() {
  const res = { code: 0, headers: {}, body: '', headersSent: false,
    writeHead(c, h = {}) { this.code = c; Object.assign(this.headers, h); this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, end(b = '') { this.body += b; } };
  return res;
}
async function call(opts) {
  const req = fakeReq(opts), res = fakeRes();
  const handled = await handleAuth(req, res, new URL(req.url, 'http://localhost'));
  return { handled, res };
}

const sign = exp => crypto.createHmac('sha256', crypto.createHash('sha256').update('gta-auth-v1:pw-legacy').digest()).update(String(exp)).digest('base64url');

test('登录页 HTML 与改动前一致', async () => {
  const { handled, res } = await call({ path: '/login' });
  assert.equal(handled, true);
  assert.equal(res.code, 200);
  // 改动前登录页全文的 sha256（逐字快照）
  assert.equal(crypto.createHash('sha256').update(res.body).digest('hex'), '02eacb87526c59e55d6b32a15773a6c956ce47b83d66a8a7ea032d6bd5199e3b');
  assert.match(res.body, /请输入访问密码/);
  assert.match(res.body, /name="password"/);
  assert.doesNotMatch(res.body, /用户名|邀请码/);
});

test('错密码 401，对密码 303 + cookie', async () => {
  const bad = await call({ method: 'POST', path: '/login', body: 'password=nope', ip: '9.9.9.1' });
  assert.equal(bad.res.code, 401);
  assert.match(bad.res.body, /密码不对/);
  const ok = await call({ method: 'POST', path: '/login', body: 'password=pw-legacy', ip: '9.9.9.1' });
  assert.equal(ok.res.code, 303);
  assert.equal(ok.res.headers.location, '/');
  const m = ok.res.headers['set-cookie'].match(/^gta_auth=(\d+)\.([\w-]+); Path=\/; Max-Age=15552000; HttpOnly; SameSite=Lax$/);
  assert.ok(m, ok.res.headers['set-cookie']);
  assert.equal(m[2], sign(m[1]));
});

test('受保护路径：页面 302、API 401 JSON；有效 cookie 放行', async () => {
  const page = await call({ path: '/', headers: { accept: 'text/html' } });
  assert.equal(page.res.code, 302); assert.equal(page.res.headers.location, '/login');
  const api = await call({ path: '/api/vehicles' });
  assert.equal(api.res.code, 401); assert.equal(api.res.body, '{"error":"login_required"}');
  const exp = Math.floor(Date.now() / 1000) + 100;
  const pass = await call({ path: '/api/vehicles', headers: { cookie: `gta_auth=${exp}.${sign(exp)}` } });
  assert.equal(pass.handled, false);
  const forged = await call({ path: '/api/vehicles', headers: { cookie: `gta_auth=${exp}.${sign(exp - 1)}` } });
  assert.equal(forged.res.code, 401);
});

test('公开路径放行，/logout 清 cookie', async () => {
  for (const p of ['/healthz', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png']) assert.equal((await call({ path: p })).handled, false, p);
  const out = await call({ path: '/logout' });
  assert.equal(out.res.code, 302);
  assert.equal(out.res.headers['set-cookie'], 'gta_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
});

test('同一 IP 失败 10 次后 429', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call({ method: 'POST', path: '/login', body: 'password=x', ip: '7.7.7.7' })).res.code, 401);
  assert.equal((await call({ method: 'POST', path: '/login', body: 'password=pw-legacy', ip: '7.7.7.7' })).res.code, 429);
});

test('/register、/api/account/me 在旧模式下不被特殊处理', async () => {
  const r = await call({ method: 'POST', path: '/register', body: 'x=1' });
  assert.equal(r.res.code, 401);   // 未登录的非页面请求
  const me = await call({ path: '/api/account/me' });
  assert.equal(me.res.code, 401);
});
