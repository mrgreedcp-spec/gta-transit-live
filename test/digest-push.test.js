// 集成测试：push.js 的每日摘要调度。web-push 和 kv 用假的（不发真推送、不写 data/kv.json）。
// 运行：node --test --experimental-test-module-mocks test/digest-push.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const sent = [], store = new Map();
mock.module('web-push', { namedExports: {
  setVapidDetails() {}, generateVAPIDKeys: () => ({ publicKey: 'p', privateKey: 'k' }),
  async sendNotification(sub, payload) { sent.push(JSON.parse(payload)); },
} });
const kvUrl = new URL('../server/kv.js', import.meta.url).href;
mock.module(kvUrl, { namedExports: {
  kvPersistent: true,
  kvGet: async k => (store.has(k) ? structuredClone(store.get(k)) : null),
  kvSet: async (k, v) => { store.set(k, structuredClone(v)); },
  kvDel: async k => { store.delete(k); },
} });
process.env.VAPID_PUBLIC_KEY = 'p'; process.env.VAPID_PRIVATE_KEY = 'k';

// 多伦多 2026-11-17（周二）07:29:50 = UTC 12:29:50
mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-11-17T12:29:50Z') });
const P = await import('../server/push.js');
const nowS = () => Math.floor(Date.now() / 1000);
await P.initPush(async (ag, id) => (id === '1762' ? [{ routeShort: '9', time: nowS() + 180 }, { routeShort: '48', time: nowS() + 720 }] : []));
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'a', auth: 'b' } };
const { id } = await P.subscribe(sub, 'zh');
const flush = () => new Promise(r => setImmediate(r));
const tick = async s => { mock.timers.tick(s * 1000); for (let i = 0; i < 20; i++) await flush(); };

test('到点推一条，同一天不重复，重新订阅不丢设置', async () => {
  const dg = await P.setDigest(id, { enabled: true, at: '07:30', days: [2], stops: [{ agency: 'miway', id: '1762', name: 'Erin Mills&Thomas' }, { agency: 'miway', id: '0652', name: '店旁' }] });
  assert.equal(dg.lastDate, null);                 // 07:29 保存，还没到点
  await tick(5); assert.equal(sent.length, 0);
  await tick(30);                                   // 07:30:25
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '收藏站点 07:30');
  assert.equal(sent[0].body, 'Erin Mills&Thomas：9 3分 · 48 12分\n店旁：—');
  assert.equal(sent[0].url, '/?tab=favs');
  assert.equal(store.get('push:dev:' + id).digest.lastDate, '2026-11-17');   // 已持久化，重启也不会再发
  await tick(300); assert.equal(sent.length, 1);
  await P.subscribe(sub, 'zh');                     // 保存提醒会重新订阅
  assert.equal(P.getDigest(id).enabled, true);
  await P.setDigest(id, { stops: [{ agency: 'miway', id: '1762', name: 'A' }] });   // 收藏同步
  assert.equal(P.getDigest(id).lastDate, '2026-11-17');
  assert.equal(P.getDigest(id).stops.length, 1);
});

test('休眠醒来补发；过了点再打开从明天开始', async () => {
  P.getDigest(id).lastDate = '2026-11-16';          // 当作今天还没发（例如服务器 07:30 在睡）
  await P.setDigest(id, { stops: [{ agency: 'miway', id: '1762', name: 'A' }] });   // 只同步收藏，不改 lastDate
  const n = sent.length;
  await tick(30);                                    // 约 07:36，在 90 分钟宽限内 → 补发
  assert.equal(sent.length, n + 1);
  assert.equal(P.getDigest(id).lastDate, '2026-11-17');
  P.getDigest(id).lastDate = '2026-11-16';
  await P.setDigest(id, { enabled: true, at: '07:00', days: [2] });   // 已过 07:00 → 记为今天已发
  assert.equal(P.getDigest(id).lastDate, '2026-11-17');
  await tick(60); assert.equal(sent.length, n + 1);
  P.getDigest(id).lastDate = '2026-11-16';
  await P.setDigest(id, { days: [3] });                                // 周三才推：今天（周二）不推
  await tick(60); assert.equal(sent.length, n + 1);
});

test('立即发一次不改 lastDate', async () => {
  const before = P.getDigest(id).lastDate, n = sent.length;
  await P.sendDigestNow(id);
  assert.equal(sent.length, n + 1);
  assert.equal(P.getDigest(id).lastDate, before);
});

test('给 Mac 的时间表：只含启用且有站点的，去重，只有 at 和 days', async () => {
  await P.setDigest(id, { enabled: true, at: '07:30', days: [1, 2], stops: [{ agency: 'miway', id: '1762', name: 'A' }] });
  const sub2 = { endpoint: 'https://fcm.googleapis.com/fcm/send/y', keys: { p256dh: 'a', auth: 'b' } };
  const id2 = (await P.subscribe(sub2, 'zh')).id;
  await P.setDigest(id2, { enabled: true, at: '07:30', days: [2, 1], stops: [{ agency: 'miway', id: '9', name: 'B' }] });
  assert.deepEqual(P.digestSchedule(), [{ at: '07:30', days: [1, 2] }]);
  await P.setDigest(id2, { at: '06:00', days: [0] });
  assert.deepEqual(P.digestSchedule(), [{ at: '06:00', days: [0] }, { at: '07:30', days: [1, 2] }]);
  await P.setDigest(id2, { enabled: false });
  await P.setDigest(id, { stops: [] });
  assert.deepEqual(P.digestSchedule(), []);
});
