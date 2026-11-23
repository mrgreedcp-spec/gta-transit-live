// 旧模式（共享访问密码）：增长统计完全不介入，?ref 不设 cookie，登录页逐字不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.APP_PASSWORD = 'pw-legacy';
delete process.env.SESSION_SECRET;
process.env.ACCOUNTS = '1';   // 开了开关但缺 SESSION_SECRET：仍走旧逻辑
process.env.ADMIN_USER = 'boss';
const { handleAuth } = await import('../server/auth.js');
const G = await import('../server/growth.js');

async function call(path, headers = {}) {
  const req = { method: 'GET', url: path, headers, socket: { remoteAddress: '5.5.5.5' }, async *[Symbol.asyncIterator]() {} };
  const res = { code: 0, headers: {}, body: '', writeHead(c, h = {}) { this.code = c; Object.assign(this.headers, h); }, setHeader(k, v) { this.headers[k] = v; }, end(b = '') { this.body += b; } };
  await handleAuth(req, res, new URL(path, 'http://localhost'));
  return res;
}

test('旧模式：?ref 不设 cookie，登录页与原来一致，增长统计未启用', async () => {
  const a = await call('/?ref=xhs', { accept: 'text/html' });
  assert.equal(a.code, 302); assert.equal(a.headers.location, '/login'); assert.equal(a.headers['set-cookie'], undefined);
  const b = await call('/login?ref=xhs');
  assert.equal(b.headers['set-cookie'], undefined);
  assert.equal(crypto.createHash('sha256').update(b.body).digest('hex'), '02eacb87526c59e55d6b32a15773a6c956ce47b83d66a8a7ea032d6bd5199e3b');
  assert.equal(G.growthOn(), false);
  assert.equal(G.adminAsset('/admin', 'anyone'), null);
});
