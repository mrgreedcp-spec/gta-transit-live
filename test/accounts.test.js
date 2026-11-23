// 账号模式：注册、登录、会话、限流、防伪造、收藏。kv 用内存假实现并计数，检查请求路径不打存储。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const store = new Map(); let kvCalls = 0, failIndexWrite = false;
mock.module(new URL('../server/kv.js', import.meta.url).href, { namedExports: {
  kvPersistent: true,
  kvGet: async k => { kvCalls++; return store.has(k) ? structuredClone(store.get(k)) : null; },
  kvSet: async (k, v) => { kvCalls++; if (failIndexWrite && k === 'acct:index') throw new Error('boom'); store.set(k, structuredClone(v)); },
  kvDel: async k => { kvCalls++; store.delete(k); },
} });
process.env.ACCOUNTS = '1';
process.env.APP_PASSWORD = 'invite-code-1';
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.MAX_USERS = '6';
const { handleAuth } = await import('../server/auth.js');
const A = await import('../server/accounts.js');
await A.initAccounts();

function fakeReq({ method = 'GET', path = '/', headers = {}, body = '', ip = '1.1.1.1' } = {}) {
  return { method, url: path, headers: { host: 'app.test', ...headers }, socket: { remoteAddress: ip },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
}
function fakeRes() {
  return { code: 0, headers: {}, body: '', writeHead(c, h = {}) { this.code = c; Object.assign(this.headers, h); }, setHeader(k, v) { this.headers[k] = v; }, end(b = '') { this.body += b; } };
}
async function call(opts) {
  const req = fakeReq(opts), res = fakeRes();
  const handled = await handleAuth(req, res, new URL(req.url, 'http://app.test'));
  return { handled, res, req };
}
const form = o => new URLSearchParams(o).toString();
const cookieOf = res => (res.headers['set-cookie'] || '').match(/gta_sess=([^;]+)/)?.[1];
const reg = (u, p = 'longpassword', ip = '2.2.2.' + Math.floor(Math.random() * 250), invite = 'invite-code-1') =>
  call({ method: 'POST', path: '/register', body: form({ invite, username: u, password: p }), ip });
const login = (u, p, ip = '3.3.3.' + Math.floor(Math.random() * 250)) => call({ method: 'POST', path: '/login', body: form({ username: u, password: p }), ip });
const asUser = (c, path = '/api/vehicles', extra = {}) => call({ path, headers: { cookie: `gta_sess=${c}` }, ...extra });

let alice;
test('注册：邀请码错 401；正常注册 303 + 会话 cookie；用户名规范化', async () => {
  const bad = await reg('alice', 'longpassword', '2.2.2.1', 'nope');
  assert.equal(bad.res.code, 401); assert.match(bad.res.body, /邀请码不对/);
  const ok = await reg('  Alice ', 'longpassword', '2.2.2.1');
  assert.equal(ok.res.code, 303); assert.equal(ok.res.headers.location, '/');
  assert.match(ok.res.headers['set-cookie'], /^gta_sess=v1\.[\w-]+\.[\w-]+\.\d+\.[\w-]+; Path=\/; Max-Age=15552000; HttpOnly; SameSite=Lax$/);
  alice = cookieOf(ok.res);
  const me = await asUser(alice);
  assert.equal(me.handled, false); assert.equal(me.req.user.name, 'alice');
  const rec = store.get('acct:user:' + me.req.user.id);
  assert.ok(rec.pw.hash && rec.pw.salt); assert.ok(!JSON.stringify(rec).includes('longpassword'));
});

test('注册校验：重名 409、非法用户名 400、弱密码 400', async () => {
  assert.equal((await reg('ALICE')).res.code, 409);
  assert.equal((await reg('a b')).res.code, 400);
  assert.equal((await reg('ab')).res.code, 400);
  assert.equal((await reg('bob', 'short')).res.code, 400);
  assert.equal((await reg('bobby', 'bobby')).res.code, 400);
  assert.equal((await reg('bobby', 'invite-code-1')).res.code, 400);
});

test('同名并发注册只成功一个', async () => {
  const rs = await Promise.all([reg('carol'), reg('carol'), reg('CAROL')]);
  assert.deepEqual(rs.map(r => r.res.code).sort(), [303, 409, 409]);
});

test('登录：用户不存在和密码错返回完全一样；正确密码 303', async () => {
  const a = await login('alice', 'wrongpassword'), b = await login('nobody', 'wrongpassword');
  assert.equal(a.res.code, 401); assert.equal(b.res.code, 401);
  assert.equal(a.res.body, b.res.body.replace('value="nobody"', 'value="alice"'));
  const ok = await login('ALICE', 'longpassword');
  assert.equal(ok.res.code, 303); assert.ok(cookieOf(ok.res));
});

test('cookie 篡改、过期、旧 gta_auth、用邀请码派生的密钥伪造：全部拒绝', async () => {
  const [v, uid, sid, exp, m] = alice.split('.');
  const flip = s => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');
  const forge = (key, s) => `${s}.${crypto.createHmac('sha256', key).update(s).digest('base64url')}`;
  const bad = [
    [v, flip(uid), sid, exp, m].join('.'), [v, uid, flip(sid), exp, m].join('.'), [v, uid, sid, +exp + 1, m].join('.'),
    [v, uid, sid, exp, flip(m)].join('.'), [v, uid, sid, exp].join('.'), alice + '.x', 'v2.' + alice.slice(3),
    forge(crypto.createHash('sha256').update('gta-auth-v1:invite-code-1').digest(), `v1.${uid}.${sid}.${exp}`),
    forge(crypto.createHash('sha256').update('gta-sess-v1:invite-code-1').digest(), `v1.${uid}.${sid}.${exp}`),
    A.signSession(uid, sid, Math.floor(Date.now() / 1000) - 5),
  ];
  for (const c of bad) { const r = await asUser(c); assert.equal(r.res.code, 401, c); }
  const legacyExp = Math.floor(Date.now() / 1000) + 100;
  const legacy = `gta_auth=${legacyExp}.${crypto.createHmac('sha256', crypto.createHash('sha256').update('gta-auth-v1:invite-code-1').digest()).update(String(legacyExp)).digest('base64url')}`;
  const page = await call({ path: '/', headers: { cookie: legacy, accept: 'text/html' } });
  assert.equal(page.res.code, 302); assert.equal(page.res.headers.location, '/login');
});

test('已登录请求不读写存储', async () => {
  const before = kvCalls;
  for (let i = 0; i < 100; i++) assert.equal((await asUser(alice)).handled, false);
  assert.equal(kvCalls, before);
});

test('登出只让这台设备下线；改密码让其他设备全部下线', async () => {
  const c2 = cookieOf((await login('alice', 'longpassword')).res), c3 = cookieOf((await login('alice', 'longpassword')).res);
  const u = (await asUser(c2)).req.user;
  await A.logout(u.id, u.sid);
  assert.equal((await asUser(c2)).res.code, 401);
  assert.equal((await asUser(c3)).handled, false);
  await assert.rejects(A.changePassword(u.id, 'wrong-old-pw', 'newpassword1', 'invite-code-1'), /bad_password/);
  await assert.rejects(A.changePassword(u.id, 'longpassword', 'short', 'invite-code-1'), /weak_password/);
  const s = await A.changePassword(u.id, 'longpassword', 'newpassword1', 'invite-code-1');
  assert.equal((await asUser(c3)).res.code, 401);
  assert.equal((await asUser(alice)).res.code, 401);
  alice = s.cookie;
  assert.equal((await asUser(alice)).handled, false);
  assert.equal((await login('alice', 'longpassword')).res.code, 401);
  assert.equal((await login('alice', 'newpassword1')).res.code, 303);
});

test('同一用户名失败 10 次后，换 IP 也 429', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login('carol', 'wrongpass' + i, '5.5.5.' + i)).res.code, 401);
  assert.equal((await login('carol', 'longpassword', '6.6.6.6')).res.code, 429);
});

test('跨站来源的写请求 403；未登录 API 401、页面跳登录', async () => {
  const r = await asUser(alice, '/api/favs', { method: 'PUT', headers: { cookie: `gta_sess=${alice}`, origin: 'https://evil.example' } });
  assert.equal(r.res.code, 403);
  const same = await asUser(alice, '/api/favs', { method: 'PUT', headers: { cookie: `gta_sess=${alice}`, origin: 'https://app.test' } });
  assert.equal(same.handled, false);
  const f = await call({ method: 'POST', path: '/login', body: form({ username: 'alice', password: 'newpassword1' }), headers: { origin: 'https://evil.example' } });
  assert.equal(f.res.code, 403);
  assert.equal((await call({ path: '/api/favs' })).res.body, '{"error":"login_required"}');
  assert.equal((await call({ path: '/', headers: { accept: 'text/html' } })).res.headers.location, '/login');
  for (const p of ['/login', '/register', '/sw.js', '/healthz']) assert.notEqual((await call({ path: p })).res.code, 401, p);
});

test('收藏：读写往返、版本冲突 409、账号之间隔离', async () => {
  const uid = (await asUser(alice)).req.user.id;
  const bob = (await asUser(cookieOf((await reg('bob_2')).res))).req.user.id;
  assert.deepEqual(A.getFavs(uid), { favs: [], rev: 0 });
  const r = await A.setFavs(uid, [{ agency: 'miway', id: '1762', name: 'Erin Mills', lat: 43.5, lon: -79.6, junk: 1 }, { agency: 'miway', id: '1762' }, { id: 'x' }], 0);
  assert.equal(r.rev, 1); assert.deepEqual(r.favs, [{ agency: 'miway', id: '1762', name: 'Erin Mills', lat: 43.5, lon: -79.6 }]);
  await assert.rejects(A.setFavs(uid, [], 0), e => e.code === 409 && e.body.rev === 1);
  assert.deepEqual(A.getFavs(bob), { favs: [], rev: 0 });
  const many = Array.from({ length: 150 }, (_, i) => ({ agency: 'ttc', id: String(i), name: 'S' }));
  assert.equal((await A.setFavs(uid, many, 1)).favs.length, 100);
});

test('人数已满 403；索引写失败时回滚', async () => {
  failIndexWrite = true;
  const r = await reg('dave_x');
  assert.equal(r.res.code, 503);
  assert.ok(![...store.values()].some(v => v?.name === 'dave_x'));
  failIndexWrite = false;
  while (A.userCount() < 6) assert.equal((await reg('u' + A.userCount() + 'x')).res.code, 303);
  assert.equal((await reg('toomany')).res.code, 403);
});

test('重启后从存储恢复，会话仍有效', async () => {
  A._reset();
  const page = await asUser(alice, '/', { headers: { cookie: `gta_sess=${alice}`, accept: 'text/html' } });
  assert.equal(page.res.code, 503);   // 未载入：不踢回登录页
  await A.initAccounts();
  assert.equal((await asUser(alice)).handled, false);
  assert.equal(A.getFavs((await asUser(alice)).req.user.id).favs.length, 100);
});

test('回归：同一账号并发写数据不互相覆盖', async () => {
  const uid = A.uidByName('alice');
  const slow = ms => new Promise(r => setTimeout(r, ms));
  await Promise.all([
    A.updateData(uid, async d => { await slow(30); return { ...d, rules: [...(d.rules || []), { id: 'r1' }] }; }),
    A.updateData(uid, async d => ({ ...d, rules: [...(d.rules || []), { id: 'r2' }] })),
    A.setFavs(uid, [{ agency: 'miway', id: 'NEW', name: 'x' }], A.getFavs(uid).rev),
  ]);
  const d = A.getData(uid);
  assert.deepEqual(d.rules.map(r => r.id), ['r1', 'r2']);
  assert.deepEqual(d.favs.map(f => f.id), ['NEW']);
  assert.deepEqual(store.get('acct:data:' + uid).rules.map(r => r.id), ['r1', 'r2']);
});

test('回归：改密码和用旧密码登录同时发生，改密码不会被撤销', async () => {
  for (const order of [0, 1]) {
    const name = ['carol', 'bob_2'][order];   // 人数已满，用前面注册过的账号（密码 longpassword）
    const uid = A.uidByName(name);
    const jobs = [A.login(name, 'longpassword'), A.changePassword(uid, 'longpassword', 'newpassword' + order, 'x')];
    if (order) jobs.reverse();
    await Promise.all(jobs);
    assert.equal(await A.login(name, 'longpassword'), null, 'order ' + order);
    assert.ok(await A.login(name, 'newpassword' + order));
    assert.ok(store.get('acct:user:' + uid).pw.hash === A._user(uid).pw.hash);
  }
});
