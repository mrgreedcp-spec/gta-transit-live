// 冷启动时存储超时：推送不能整段停掉，要自动重试载入。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let fails = 2;
const store = new Map([['push:index', ['d1']], ['push:dev:d1', { sub: {}, rules: [], digest: { enabled: true, at: '07:30', days: [1], stops: [{ agency: 'miway', id: '1', name: 'A' }] } }]]);
mock.module('web-push', { namedExports: { setVapidDetails() {}, generateVAPIDKeys: () => ({}), async sendNotification() {} } });
mock.module(new URL('../server/kv.js', import.meta.url).href, { namedExports: {
  kvPersistent: true,
  kvGet: async k => { if (fails > 0) { fails--; throw new Error('The operation was aborted due to timeout'); } return store.get(k) ?? null; },
  kvSet: async () => {}, kvDel: async () => {},
} });
process.env.VAPID_PUBLIC_KEY = 'p'; process.env.VAPID_PRIVATE_KEY = 'k';
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const P = await import('../server/push.js');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('存储超时后 30 秒自动重试，恢复推送', async () => {
  await P.initPush(async () => []);
  assert.equal(P.pushState.enabled, false);
  assert.match(P.pushState.reason, /存储不可用/);
  assert.throws(() => P.digestSchedule(), /存储不可用/);
  mock.timers.tick(P.RETRY_MS); await flush();      // 第二次还失败
  assert.equal(P.pushState.enabled, false);
  mock.timers.tick(P.RETRY_MS); await flush();      // 第三次成功
  assert.equal(P.pushState.enabled, true);
  assert.equal(P.pushState.reason, '');
  assert.deepEqual(P.digestSchedule(), [{ at: '07:30', days: [1] }]);
  assert.deepEqual(P.digestStats(), { devices: 1, digests: 1, enabled: 1, ready: 1 });
});
