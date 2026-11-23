// 旧模式（共享访问密码）：反馈照常能提交（不带用户名），但没有查看入口；登录页逐字不变。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const store = new Map();
mock.module(new URL('../server/kv.js', import.meta.url).href, { namedExports: {
  kvPersistent: true,
  kvGet: async k => (store.has(k) ? structuredClone(store.get(k)) : null),
  kvSet: async (k, v) => { store.set(k, structuredClone(v)); },
  kvDel: async k => { store.delete(k); },
} });
process.env.APP_PASSWORD = 'pw-legacy';
delete process.env.SESSION_SECRET;
process.env.ACCOUNTS = '1';   // 开了开关但缺 SESSION_SECRET：仍走旧逻辑
process.env.ADMIN_USER = 'boss';
const { handleAuth } = await import('../server/auth.js');
const F = await import('../server/feedback.js');

async function call(method, path, headers = {}) {
  const req = { method, url: path, headers, socket: { remoteAddress: '5.5.5.5' }, async *[Symbol.asyncIterator]() {} };
  const res = { code: 0, headers: {}, body: '', writeHead(c, h = {}) { this.code = c; Object.assign(this.headers, h); }, setHeader(k, v) { this.headers[k] = v; }, end(b = '') { this.body += b; } };
  const handled = await handleAuth(req, res, new URL(path, 'http://localhost'));
  return { handled, res };
}
const sign = exp => crypto.createHmac('sha256', crypto.createHash('sha256').update('gta-auth-v1:pw-legacy').digest()).update(String(exp)).digest('base64url');

test('旧模式：带访问密码 cookie 能到达反馈接口，不带 401', async () => {
  const exp = Math.floor(Date.now() / 1000) + 100;
  assert.equal((await call('POST', '/api/feedback', { cookie: `gta_auth=${exp}.${sign(exp)}` })).handled, false);
  const no = await call('POST', '/api/feedback');
  assert.equal(no.res.code, 401); assert.equal(no.res.body, '{"error":"login_required"}');
});

test('旧模式：提交不带用户名；没有查看入口', async () => {
  await F.addFeedback({ text: 'legacy works', ip: '5.5.5.5' });
  const it = store.get('feedback:list')[0];
  assert.equal(it.text, 'legacy works'); assert.equal('user' in it, false);
  await assert.rejects(F.feedbackList('anyone'), e => e.code === 404);
});

test('旧模式登录页与原来一致', async () => {
  const r = await call('GET', '/login');
  assert.equal(crypto.createHash('sha256').update(r.res.body).digest('hex'), '02eacb87526c59e55d6b32a15773a6c956ce47b83d66a8a7ea032d6bd5199e3b');
});
