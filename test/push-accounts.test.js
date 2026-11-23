// 账号模式下的推送归属：认领设备、按账号发给全部设备、隔离、摘要、NOTIFY_USER、关闭开关后按设备快照。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const sent = [], gone = new Set(), store = new Map();
mock.module('web-push', { namedExports: {
  setVapidDetails() {}, generateVAPIDKeys: () => ({}),
  async sendNotification(sub, payload) { if (gone.has(sub.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 }); sent.push({ ep: sub.endpoint, ...JSON.parse(payload) }); },
} });
mock.module(new URL('../server/kv.js', import.meta.url).href, { namedExports: {
  kvPersistent: true,
  kvGet: async k => (store.has(k) ? structuredClone(store.get(k)) : null),
  kvSet: async (k, v) => { store.set(k, structuredClone(v)); },
  kvDel: async k => { store.delete(k); },
} });
process.env.VAPID_PUBLIC_KEY = 'p'; process.env.VAPID_PRIVATE_KEY = 'k';
process.env.NOTIFY_USER = 'alice';

// 多伦多 2026-11-17（周二）08:00:00 = UTC 13:00:00
mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-11-17T13:00:00Z') });
const A = await import('../server/accounts.js');
A.setSessionSecret('x'.repeat(40));
const P = await import('../server/push.js');
const nowS = () => Math.floor(Date.now() / 1000);
await A.initAccounts();
await P.initPush(async (ag, id) => (id === 'S1' ? [{ routeShort: '9', time: nowS() + 120, tripId: 'T1' }] : []));
P.usePushAccounts(true);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const tick = async s => { mock.timers.tick(s * 1000); await flush(); };
const sub = n => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'a' + n, auth: 'b' + n } });
const ep = n => sub(n).endpoint;
const rule = { stop: { agency: 'miway', id: 'S1', name: '站一' }, route: '9', lead: 5, days: [2], from: '07:00', to: '09:00' };

let alice, bob, devOld, devA1, devA2, devB;
test('认领：旧设备的规则、摘要复制进账号，设备上原数据保留；重复认领不重复', async () => {
  alice = (await A.register({ name: 'alice', password: 'longpassword', invite: 'inv' })).user.id;
  bob = (await A.register({ name: 'bob', password: 'longpassword', invite: 'inv' })).user.id;
  devOld = (await P.subscribe(sub('old'), 'zh')).id;
  P.usePushAccounts(false); await P.addRule(devOld, rule); P.usePushAccounts(true);
  await P.setDigest(devOld, { enabled: true, at: '09:30', days: [2], stops: [{ agency: 'miway', id: 'S1', name: '站一' }] });
  const r = await P.subscribe(sub('old'), 'zh', alice);
  assert.equal(r.rules.length, 1);
  assert.equal(P.acctRules(alice).length, 1);
  assert.equal(P.acctGetDigest(alice).at, '09:30');
  assert.equal(store.get('push:dev:' + devOld).rules.length, 1);   // 设备上的原规则还在（回滚用）
  await P.subscribe(sub('old'), 'zh', alice);
  assert.equal(P.acctRules(alice).length, 1);
});

test('一个账号两台设备都收到，同一班车只推一次；别的账号收不到', async () => {
  devA2 = (await P.subscribe(sub('a2'), 'zh', alice)).id;
  devB = (await P.subscribe(sub('b1'), 'zh', bob)).id;
  sent.length = 0;
  await tick(30);
  assert.deepEqual(sent.map(s => s.ep).sort(), [ep('a2'), ep('old')].sort());
  assert.equal(sent[0].title, '站一');
  await tick(30);
  assert.equal(sent.length, 2);   // 去重
});

test('账号之间隔离：bob 看不到、删不掉 alice 的规则和设备', async () => {
  assert.deepEqual(P.acctRules(bob), []);
  await assert.rejects(P.acctUnsubscribe(bob, devA2), /unknown_device/);
  await P.acctDeleteRule(bob, P.acctRules(alice)[0].id);
  assert.equal(P.acctRules(alice).length, 1);
  await assert.rejects(P.acctSendTest(A.uidByName('nobody') || 'zzz'), /no_device/);
});

test('不带账号重新订阅（旧接口）不丢 userId', async () => {
  await P.subscribe(sub('a2'), 'zh');
  assert.equal(store.get('push:dev:' + devA2).userId, alice);
});

test('失效设备（410）被清掉，另一台照常收到', async () => {
  gone.add(ep('a2')); sent.length = 0;
  await P.acctSendTest(alice);
  assert.deepEqual(sent.map(s => s.ep), [ep('old')]);
  assert.equal(store.has('push:dev:' + devA2), false);
  gone.clear();
});

test('账号摘要到点发给该账号的设备，并记 lastDate', async () => {
  sent.length = 0;
  for (let i = 0; i < 180; i++) await tick(30);   // 一步步走到 09:30 之后（和真实一样每 30 秒检查一次）
  const dg = sent.filter(s => s.tag === 'digest');
  assert.deepEqual(dg.map(s => s.ep), [ep('old')]);
  assert.equal(A.getData(alice).digest.lastDate, '2026-11-17');
  assert.deepEqual(P.digestSchedule(), [{ at: '09:30', days: [2] }]);
});

test('NOTIFY_USER：外部提醒只发给这个账号', async () => {
  sent.length = 0;
  const r = await P.notifyAll({ title: '通勤', body: 'x', tag: 'n', key: 'k1' });
  assert.deepEqual(r, { devices: 1, sent: 1 });
  assert.deepEqual(sent.map(s => s.ep), [ep('old')]);
});

test('关掉账号模式：认领过的设备按自己保存的快照推送', async () => {
  P.usePushAccounts(false);
  await P.acctAddRule(alice, { ...rule, stop: { agency: 'miway', id: 'S2', name: '站二' } });   // 账号里新加的，旧模式看不到
  sent.length = 0;
  const r = await P.notifyAll({ title: '通勤', body: 'y', tag: 'n', key: 'k2' });
  assert.equal(r.devices, 2);   // 不再按 NOTIFY_USER 过滤（old + b1；a2 已因 410 删除）
  assert.deepEqual(P.getRules(devOld).map(x => x.stop.id), ['S1']);
  P.usePushAccounts(true);
});

test('回归：账号还没载入时摘要时间表回 503（别让 Mac 缓存空表）', async () => {
  A._reset();
  assert.throws(() => P.digestSchedule(), /accounts_loading/);
  await A.initAccounts();
  assert.deepEqual(P.digestSchedule(), [{ at: '09:30', days: [2] }]);
});
