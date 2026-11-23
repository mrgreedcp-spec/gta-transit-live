// 增长仪表盘：渠道 cookie、注册记 ref、活跃度批量写入（请求路径零 KV）、日期分桶、统计口径、管理员限定。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map(); let kvCalls = 0, failGet = false, failSet = 0;
mock.module(new URL('../server/kv.js', import.meta.url).href, { namedExports: {
  kvPersistent: true,
  kvGet: async k => { kvCalls++; if (failGet && k.startsWith('acct:seen')) throw new Error('down'); return store.has(k) ? structuredClone(store.get(k)) : null; },
  kvSet: async (k, v) => { kvCalls++; if (failSet > 0 && k.startsWith('acct:seen')) { failSet--; throw new Error('down'); } store.set(k, structuredClone(v)); },
  kvDel: async k => { kvCalls++; store.delete(k); },
} });
process.env.ACCOUNTS = '1';
process.env.APP_PASSWORD = 'invite-code-1';
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.ADMIN_USER = 'boss';
const { handleAuth } = await import('../server/auth.js');
const A = await import('../server/accounts.js');
const G = await import('../server/growth.js');
await A.initAccounts();

function fakeReq({ method = 'GET', path = '/', headers = {}, body = '', ip = '1.1.1.' + Math.floor(Math.random() * 250) } = {}) {
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
const sessOf = res => (res.headers['set-cookie'] || '').match(/gta_sess=([^;]+)/)?.[1];
const reg = (u, cookie = '') => call({ method: 'POST', path: '/register', headers: cookie ? { cookie } : {}, body: new URLSearchParams({ invite: 'invite-code-1', username: u, password: 'longpassword' }).toString() });
const COOKIE_RE = /^gta_ref=xhs; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/;

test('cleanRef：只收小写字母、数字、- 和 _，1–20 位', () => {
  for (const ok of ['wechat', 'a_b-1', 'x'.repeat(20)]) assert.equal(G.cleanRef(ok), ok);
  for (const bad of ['WeChat', '', 'x'.repeat(21), 'a b', 'a;b', '<script>', null, undefined, 3]) assert.equal(G.cleanRef(bad), null, String(bad));
});

test('开关关闭时不设 cookie，touch 不记', async () => {
  const r = await call({ path: '/login?ref=xhs' });
  assert.equal(r.res.headers['set-cookie'], undefined);
  G.touch('someone');
  assert.equal(G._growthState().seen.size, 0);
});

let boss, alice, bob, bossCookie, aliceCookie;
test('准备：注册 boss，开启增长统计', async () => {
  const r = await reg('boss'); bossCookie = sessOf(r.res); boss = A.uidByName('boss');
  A._reset(); await A.initAccounts();   // 管理员只认启动时已存在的账号
  await G.startGrowth({ timer: false });
  assert.equal(G.growthOn(), true);
});

test('带 ?ref 打开：未登录 302 到登录页时就记下 cookie；登录页也记', async () => {
  const a = await call({ path: '/?ref=xhs', headers: { accept: 'text/html' } });
  assert.equal(a.res.code, 302); assert.equal(a.res.headers.location, '/login');
  assert.match(a.res.headers['set-cookie'], COOKIE_RE);
  const b = await call({ path: '/login?ref=xhs' });
  assert.equal(b.res.code, 200); assert.match(b.res.headers['set-cookie'], COOKIE_RE);
});

test('非法 ref 不记；已有来源不覆盖；API 和 POST 不记', async () => {
  for (const p of ['/login?ref=BAD!', `/login?ref=${'x'.repeat(21)}`]) assert.equal((await call({ path: p })).res.headers['set-cookie'], undefined, p);
  assert.equal((await call({ path: '/login?ref=xhs', headers: { cookie: 'gta_ref=wechat' } })).res.headers['set-cookie'], undefined);
  assert.equal((await call({ path: '/api/vehicles?ref=xhs' })).res.headers['set-cookie'], undefined);
  const post = await call({ method: 'POST', path: '/login?ref=xhs', body: 'username=boss&password=wrongpass1' });
  assert.equal(post.res.headers['set-cookie'], undefined);
});

test('注册时把来源写进账号；没有或伪造的来源不写；改名后还在', async () => {
  const ra = await reg('alice', 'gta_ref=reddit'); aliceCookie = sessOf(ra.res); alice = A.uidByName('alice');
  assert.equal(A._user(alice).ref, 'reddit');
  assert.equal(store.get('acct:user:' + alice).ref, 'reddit');
  await reg('bob'); bob = A.uidByName('bob');
  assert.equal('ref' in A._user(bob), false);
  await reg('carol', 'gta_ref=%3Cscript%3E');
  assert.equal('ref' in A._user(A.uidByName('carol')), false);
  await A.renameUser(alice, 'alice_x', 'longpassword');
  assert.equal(A._user(alice).ref, 'reddit');
});

test('增长数据只给管理员；不含用户名、uid、密码', async () => {
  assert.throws(() => G.growthStats(alice), e => e.code === 404 && e.message === 'not found');
  const g = G.growthStats(boss);
  const s = JSON.stringify(g);
  for (const bad of ['hash', 'salt', 'sid', 'boss', 'alice', 'carol', alice, boss]) assert.ok(!s.includes(bad), bad);
  assert.equal(g.accounts.total, 4);
  delete process.env.ADMIN_USER;
  assert.throws(() => G.growthStats(boss), e => e.code === 404);
  process.env.ADMIN_USER = 'boss';
});

test('/admin 页面文件只给管理员，精确匹配', () => {
  assert.equal(G.adminAsset('/admin', boss), 'admin.html');
  assert.equal(G.adminAsset('/admin.js', boss), 'admin.js');
  for (const [p, u] of [['/admin', alice], ['/admin', undefined], ['/admin.html', boss], ['/Admin', boss], ['/%61dmin.js', boss], ['/admin/', boss]]) assert.equal(G.adminAsset(p, u), null, `${p} ${u}`);
});

test('已登录请求只在内存记活跃，不读写存储', async () => {
  const n = kvCalls;
  for (let i = 0; i < 20; i++) { const r = await call({ path: '/api/vehicles', headers: { cookie: `gta_sess=${aliceCookie}` } }); assert.equal(r.req.user.id, alice); }
  assert.equal(kvCalls, n);
  assert.equal(G._growthState().seen.get(alice), G.torontoDate());
});

test('多伦多日期分桶：冬令时、夏令时边界', () => {
  assert.equal(G.torontoDate(Date.parse('2026-11-23T04:30:00Z')), '2026-11-22');
  assert.equal(G.torontoDate(Date.parse('2026-11-23T05:00:00Z')), '2026-11-23');
  assert.equal(G.torontoDate(Date.parse('2026-07-01T03:59:00Z')), '2026-06-30');
  assert.equal(G.torontoDate(Date.parse('2026-07-01T04:00:00Z')), '2026-07-01');
});

test('日期序列跨夏令时切换：30 天连续、不重复', () => {
  const d = G.lastDays('2026-11-10', 30);
  assert.equal(d.length, 30); assert.equal(new Set(d).size, 30);
  assert.equal(d.at(-1), '2026-11-10'); assert.ok(d.includes('2026-11-01'));
  for (let i = 1; i < d.length; i++) assert.equal(Date.parse(d[i]) - Date.parse(d[i - 1]), 864e5);
});

test('统计口径：新增、累计、活跃边界、渠道与激活', () => {
  const now = Date.parse('2026-11-23T17:00:00Z');   // 多伦多 11-23 中午
  const day = (s) => Date.parse(`${s}T17:00:00Z`);
  const users = [
    { id: 'u1', created: day('2026-09-01'), ref: null, favs: 0, rules: 0 },          // 30 天以前
    { id: 'u2', created: day('2026-11-17'), ref: 'xhs', favs: 2, rules: 0 },         // 今天 -6：算近 7 天
    { id: 'u3', created: day('2026-11-16'), ref: 'xhs', favs: 0, rules: 1 },         // 今天 -7：不算近 7 天；建了提醒 = 激活
    { id: 'u4', created: Date.parse('2026-11-23T04:30:00Z'), ref: 'wechat', favs: 0, rules: 0 },   // UTC 11-23，多伦多 11-22
  ];
  const seen = new Map([['u1', '2026-11-23'], ['u2', '2026-11-17'], ['u3', '2026-11-16'], ['gone', '2026-11-23']]);
  const g = G.buildGrowth({ users, seen, dau: { '2026-11-20': 3 }, todaySet: new Set(['u1', 'gone']), max: 50, now });
  assert.equal(g.today, '2026-11-23');
  assert.deepEqual(g.accounts, { total: 4, max: 50, new7: 2, new30: 3 });
  assert.equal(g.signups.length, 30); assert.equal(g.signups.at(-1).total, 4); assert.equal(g.signups[0].total, 1);
  assert.equal(g.signups.find(s => s.date === '2026-11-22').n, 1);
  assert.deepEqual(g.active, { today: 1, d7: 2, d30: 3 });   // 已删除的账号 gone 不算；u3 在 7 天外
  assert.equal(g.dau.find(d => d.date === '2026-11-20').n, 3);
  assert.equal(g.since, '2026-11-20');
  assert.equal(g.dau.find(d => d.date === '2026-11-19').n, null);   // 开始统计之前：没有数据
  assert.equal(g.dau.find(d => d.date === '2026-11-21').n, 0);
  assert.deepEqual(g.channels, [{ ref: 'xhs', signups: 2, activated: 2 }, { ref: 'wechat', signups: 1, activated: 0 }, { ref: null, signups: 1, activated: 0 }]);
  assert.deepEqual(g.activation, { withFavs: 1, withRules: 1, activated: 2 });
  assert.equal(g.dau.at(-1).n, g.active.today);   // 今天的活跃：KPI 和曲线口径一致（不算不存在的账号）
});

test('批量写入：有变化才写；跨午夜把前一天定格', async () => {
  const D = Date.parse('2027-03-10T04:50:00Z');   // 多伦多 2027-03-09 23:50（离运行日期远，不和别的测试的真实时间混在一起）
  G.touch('pa', D); G.touch('pb', D);
  G.touch('pa', D + 15 * 60e3);                   // 11-24 00:05
  await G.flushSeen(D + 16 * 60e3);
  const dau = store.get('acct:dau'), seen = store.get('acct:seen');
  assert.equal(dau['2027-03-09'], 2); assert.equal(dau['2027-03-10'], 1);
  assert.equal(seen.pa, '2027-03-10'); assert.equal(seen.pb, '2027-03-09');
  const n = kvCalls;
  await G.flushSeen(D + 17 * 60e3);
  assert.equal(kvCalls, n);   // 没变化：不写
});

test('DAU 只留 90 天；载入失败不写、恢复后合并；写失败下次重试', async () => {
  G._resetGrowth();
  store.set('acct:dau', { '2026-07-27': 9, '2026-08-26': 8, '2026-08-27': 7, '2026-11-20': 5 });   // 今天 11-24：120 天前、90 天前、89 天前
  store.set('acct:seen', { old: '2026-11-20' });
  const now = Date.parse('2026-11-24T17:00:00Z');
  failGet = true;
  await G.startGrowth({ timer: false, now });
  G.touch('nu', now);
  const n = kvCalls;
  await G.flushSeen(now);
  assert.equal(store.get('acct:seen').old, '2026-11-20'); assert.equal(store.get('acct:seen').nu, undefined);   // 没覆盖
  assert.ok(kvCalls > n);   // 只重试了读
  failGet = false; failSet = 1;
  await G.flushSeen(now);   // 载入成功，写失败
  assert.equal(store.get('acct:seen').nu, undefined);
  await G.flushSeen(now);   // 重试成功
  const seen = store.get('acct:seen'), dau = store.get('acct:dau');
  assert.equal(seen.old, '2026-11-20'); assert.equal(seen.nu, '2026-11-24');
  assert.equal(dau['2026-07-27'], undefined); assert.equal(dau['2026-08-26'], undefined); assert.equal(dau['2026-08-27'], 7);
  assert.equal(dau['2026-11-20'], 5); assert.equal(dau['2026-11-24'], 1);
  assert.ok(Object.keys(dau).length <= 90);
});

test('回归：部署时新旧实例并存，写入前合并对方的活跃，不互相覆盖', async () => {
  G._resetGrowth(); store.delete('acct:seen'); store.delete('acct:dau');
  const now = Date.parse('2027-05-05T16:00:00Z'), today = '2027-05-05';
  await G.startGrowth({ timer: false, now });          // 新实例启动：存储里还没有数据
  store.set('acct:seen', { o1: today, o2: today, old: '2027-05-01' });   // 旧实例退出前写入
  store.set('acct:dau', { [today]: 2, '2027-05-01': 4 });
  G.touch('m1', now);                                   // 新实例自己见到的
  await G.flushSeen(now);
  const seen = store.get('acct:seen'), dau = store.get('acct:dau');
  assert.deepEqual(Object.keys(seen).sort(), ['m1', 'o1', 'o2', 'old']);
  assert.equal(dau[today], 3); assert.equal(dau['2027-05-01'], 4);
});

test('定时写入和退出写入撞在一起：都等同一次写完', async () => {
  const now = Date.parse('2027-05-05T17:00:00Z');
  G.touch('m2', now);
  const a = G.flushSeen(now), b = G.flushSeen(now);
  assert.equal(a, b);
  await b;
  assert.equal(store.get('acct:seen').m2, '2027-05-05');
});

test('重启后今天的活跃不归零', async () => {
  const now = Date.parse('2027-05-05T18:00:00Z');   // 上一个测试已把 m2 今天的活跃写进存储
  G._resetGrowth();
  await G.startGrowth({ timer: false, now });
  assert.equal(G.buildGrowth({ users: [{ id: 'm2', created: now, favs: 0, rules: 0 }], seen: G._growthState().seen, dau: G._growthState().dau, todaySet: G._growthState().day.uids, max: 50, now }).active.today, 1);
});
