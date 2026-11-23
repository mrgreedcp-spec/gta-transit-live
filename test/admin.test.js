// 管理员（ADMIN_USER）、管理员重置密码 + 强制改密、改用户名。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map(); let kvCalls = 0, failUserWrite = false;
const sent = [];
mock.module('web-push', { namedExports: {
  setVapidDetails() {}, generateVAPIDKeys: () => ({}),
  async sendNotification(sub, payload) { sent.push({ ep: sub.endpoint, ...JSON.parse(payload) }); },
} });
mock.module(new URL('../server/kv.js', import.meta.url).href, { namedExports: {
  kvPersistent: true,
  kvGet: async k => { kvCalls++; return store.has(k) ? structuredClone(store.get(k)) : null; },
  kvSet: async (k, v) => { kvCalls++; if (failUserWrite && k.startsWith('acct:user:')) throw new Error('boom'); store.set(k, structuredClone(v)); },
  kvDel: async k => { kvCalls++; store.delete(k); },
} });
process.env.ACCOUNTS = '1';
process.env.APP_PASSWORD = 'invite-code-1';
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.ADMIN_USER = 'boss';
process.env.NOTIFY_USER = 'boss';
process.env.VAPID_PUBLIC_KEY = 'p'; process.env.VAPID_PRIVATE_KEY = 'k';
const { handleAuth } = await import('../server/auth.js');
const A = await import('../server/accounts.js');
const P = await import('../server/push.js');
await A.initAccounts();
await P.initPush(async () => []);
P.usePushAccounts(true);

function fakeReq({ method = 'GET', path = '/', headers = {}, ip = '1.1.1.1' } = {}) {
  return { method, url: path, headers: { host: 'app.test', ...headers }, socket: { remoteAddress: ip }, async *[Symbol.asyncIterator]() {} };
}
function fakeRes() {
  return { code: 0, headers: {}, body: '', writeHead(c, h = {}) { this.code = c; Object.assign(this.headers, h); }, setHeader(k, v) { this.headers[k] = v; }, end(b = '') { this.body += b; } };
}
const asUser = async (cookie, path = '/api/vehicles') => {
  const req = fakeReq({ path, headers: { cookie: `gta_sess=${cookie}` } }), res = fakeRes();
  const handled = await handleAuth(req, res, new URL(req.url, 'http://app.test'));
  return { handled, res, req };
};
const sidOf = c => c.split('.')[2];
const sub = n => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'a' + n, auth: 'b' + n } });
const PW = 'longpassword';
const mk = async n => A.register({ name: n, password: PW, invite: 'invite-code-1' });

let boss, alice, bob, aliceCookie;
test('管理员判定：只认 ADMIN_USER；没设时不存在', async () => {
  boss = (await mk('boss')).user.id;
  const ra = await mk('alice'); alice = ra.user.id; aliceCookie = ra.cookie;
  bob = (await mk('bob')).user.id;
  assert.equal(A.isAdmin(boss), true);
  assert.equal(A.isAdmin(alice), false);
  delete process.env.ADMIN_USER;
  assert.equal(A.isAdmin(boss), false);
  assert.throws(() => A.adminList(boss), e => e.code === 404);
  process.env.ADMIN_USER = 'boss';
});

test('非管理员：列表和重置都 404', async () => {
  assert.throws(() => A.adminList(alice), e => e.code === 404 && e.message === 'not found');
  await assert.rejects(A.adminResetPassword(alice, bob), e => e.code === 404 && e.message === 'not found');
});

test('列表：人数、上限、会话数；不含密码哈希和 sid', async () => {
  await A.login('alice', PW);
  const l = A.adminList(boss);
  assert.equal(l.count, 3); assert.equal(l.max, A.MAX_USERS);
  assert.equal(l.users.find(u => u.id === alice).sessions, 2);
  assert.equal(l.users.find(u => u.id === boss).self, true);
  assert.doesNotMatch(JSON.stringify(l), /hash|salt|sid/);
});

test('重置：临时密码格式、不能重置自己、目标不存在 404；旧会话失效、推送设备不再收', async () => {
  await P.subscribe(sub('a1'), 'zh', alice, sidOf(aliceCookie));
  assert.equal(P.deviceCountByUser()[alice], 1);
  await assert.rejects(A.adminResetPassword(boss, boss), /cannot_reset_self/);
  await assert.rejects(A.adminResetPassword(boss, 'nope'), e => e.code === 404);
  const r = await A.adminResetPassword(boss, alice);
  assert.equal(r.name, 'alice');
  assert.match(r.tempPassword, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
  assert.equal(A._user(alice).mustChange, true);
  assert.ok(!JSON.stringify([...store.values()]).includes(r.tempPassword));   // 存储里没有明文
  assert.equal((await asUser(aliceCookie)).res.code, 401);
  assert.equal(P.deviceCountByUser()[alice], undefined);
  sent.length = 0;
  await assert.rejects(P.acctSendTest(alice), /no_device/);
  assert.equal(sent.length, 0);
  assert.equal(await A.login('alice', PW), null);   // 旧密码登不上
  globalThis.temp = r.tempPassword;
});

test('临时密码登录后只能改密码或登出；重启后仍拦截', async () => {
  const s = await A.login('alice', globalThis.temp);
  assert.ok(s);
  for (const p of ['/api/vehicles', '/api/favs', '/api/push/rules']) {
    const x = await asUser(s.cookie, p);
    assert.equal(x.res.code, 403, p); assert.equal(x.res.body, '{"error":"must_change_password"}');
  }
  for (const p of ['/api/account/me', '/api/account/password', '/api/account/logout', '/']) {
    const x = await asUser(s.cookie, p);
    assert.equal(x.handled, false, p);
  }
  assert.equal((await asUser(s.cookie, '/api/account/me')).req.user.mustChange, true);
  A._reset(); await A.initAccounts();
  assert.equal((await asUser(s.cookie, '/api/favs')).res.code, 403);
  globalThis.tempCookie = s.cookie;
});

test('强制改密：不能沿用临时密码；改好后清掉 mustChange，临时密码失效', async () => {
  await assert.rejects(A.changePassword(alice, globalThis.temp, globalThis.temp, 'invite-code-1'), /weak_password/);
  const s = await A.changePassword(alice, globalThis.temp, 'brandnewpass1', 'invite-code-1');
  assert.equal(A._user(alice).mustChange, undefined);
  assert.equal(store.get('acct:user:' + alice).mustChange, undefined);
  assert.equal((await asUser(s.cookie)).handled, false);
  assert.equal((await asUser(s.cookie)).req.user.mustChange, undefined);
  assert.equal(await A.login('alice', globalThis.temp), null);
  aliceCookie = s.cookie;
});

test('改名：新名能登、旧名不能；cookie 仍有效；索引不变', async () => {
  const idx = JSON.stringify(store.get('acct:index'));
  const r = await A.renameUser(alice, 'Alice_2', 'brandnewpass1');
  assert.deepEqual(r, { id: alice, name: 'alice_2' });
  assert.equal(A.uidByName('alice'), null);
  assert.equal(A.uidByName('alice_2'), alice);
  assert.equal(store.get('acct:user:' + alice).name, 'alice_2');
  assert.equal(JSON.stringify(store.get('acct:index')), idx);
  assert.equal((await asUser(aliceCookie)).req.user.name, 'alice_2');
  assert.ok(await A.login('alice_2', 'brandnewpass1'));
  assert.equal(await A.login('alice', 'brandnewpass1'), null);
});

test('改名校验：密码错、非法名、重名、保留名、管理员自己改名、密码等于新名', async () => {
  await assert.rejects(A.renameUser(alice, 'alice_3', 'wrongpass99'), /bad_password/);
  await assert.rejects(A.renameUser(alice, 'a!', 'brandnewpass1'), /bad_username/);
  await assert.rejects(A.renameUser(alice, 'bob', 'brandnewpass1'), /name_taken/);
  await assert.rejects(A.renameUser(alice, 'BOSS', 'brandnewpass1'), /name_taken/);
  await assert.rejects(A.renameUser(boss, 'boss_2', PW), /name_locked/);
  await assert.rejects(A.renameUser(alice, 'alice_2', 'brandnewpass1'), /same_name/);
  await assert.rejects(A.renameUser(alice, 'brandnewpass1', 'brandnewpass1'), /weak_password/);
});

test('并发：两人抢同一个名字、改名和注册抢同一个名字，都只成功一个', async () => {
  const rs = await Promise.allSettled([A.renameUser(alice, 'hot_name', 'brandnewpass1'), A.renameUser(bob, 'hot_name', PW)]);
  assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(rs.find(r => r.status === 'rejected').reason.message, /name_taken/);
  const winner = A.uidByName('hot_name');
  const loser = winner === alice ? bob : alice;
  assert.notEqual(A._user(loser).name, 'hot_name');
  const rs2 = await Promise.allSettled([A.renameUser(loser, 'race_x', winner === alice ? PW : 'brandnewpass1'), mk('race_x')]);
  assert.equal(rs2.filter(r => r.status === 'fulfilled').length, 1);
});

test('改名写存储失败：内存不变，名字占位已释放', async () => {
  const before = A._user(bob).name;
  failUserWrite = true;
  await assert.rejects(A.renameUser(bob, 'fail_name', PW));
  failUserWrite = false;
  assert.equal(A._user(bob).name, before);
  assert.equal(A.uidByName('fail_name'), null);
  await A.renameUser(bob, 'fail_name', PW);   // 占位已释放，能改
  assert.equal(A.uidByName('fail_name'), bob);
});

test('已登录请求和管理员列表不读写存储', async () => {
  const s = await A.login('boss', PW);
  const n = kvCalls;
  for (let i = 0; i < 50; i++) { await asUser(s.cookie); await asUser(aliceCookie); }
  A.adminList(boss); P.deviceCountByUser();
  assert.equal(kvCalls, n);
});
