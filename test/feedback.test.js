// 用户反馈：校验、落库、500 条上限、并发不丢、限流、存储故障、只给管理员看、不存 IP。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map(); let failGet = false, failSet = false, slow = false;
mock.module(new URL('../server/kv.js', import.meta.url).href, { namedExports: {
  kvPersistent: true,
  kvGet: async k => { if (failGet && k === 'feedback:list') throw new Error('down'); return store.has(k) ? structuredClone(store.get(k)) : null; },
  kvSet: async (k, v) => {
    if (failSet && k === 'feedback:list') throw new Error('down');
    v = structuredClone(v);
    if (slow && k === 'feedback:list') await new Promise(r => setTimeout(r, 5 + Math.random() * 15));
    store.set(k, v);
  },
  kvDel: async k => { store.delete(k); },
} });
process.env.ACCOUNTS = '1';
process.env.APP_PASSWORD = 'invite-code-1';
process.env.SESSION_SECRET = 's'.repeat(40);
process.env.ADMIN_USER = 'boss';
const A = await import('../server/accounts.js');
const F = await import('../server/feedback.js');
A.setSessionSecret('s'.repeat(40));
await A.initAccounts();

const NOW = Date.parse('2026-11-23T17:00:00Z');
const list = () => store.get('feedback:list') || [];
const fresh = () => { F._resetFeedback(); store.delete('feedback:list'); failGet = failSet = slow = false; };
const ctx = { tab: 'favs', ver: 'v20', standalone: true, w: 390 };

test('提交成功落库：内容、联系方式、上下文、用户名、时间', async () => {
  fresh();
  const r = await F.addFeedback({ text: '  到站时间不准  ', contact: 'wx: abc', ctx, user: 'alice', ip: '1.1.1.1' }, NOW);
  assert.equal(r.ok, true); assert.ok(r.id);
  const it = list()[0];
  assert.deepEqual({ ...it, id: undefined }, { id: undefined, at: NOW, text: '到站时间不准', contact: 'wx: abc', ctx, user: 'alice' });
});

test('空内容 400，不写存储', async () => {
  fresh();
  for (const text of ['', '  \n ', undefined, 123]) await assert.rejects(F.addFeedback({ text, ip: '1.1.1.2' }, NOW), e => e.code === 400 && e.message === 'text_required', String(text));
  assert.equal(store.has('feedback:list'), false);
});

test('超长 400：正文 1000 字可以、1001 不行；联系方式 101 不行', async () => {
  fresh();
  await F.addFeedback({ text: '好'.repeat(1000), ip: '1.1.1.3' }, NOW);
  await assert.rejects(F.addFeedback({ text: '好'.repeat(1001), ip: '1.1.1.3' }, NOW), e => e.code === 400 && e.message === 'too_long');
  await assert.rejects(F.addFeedback({ text: 'x', contact: 'c'.repeat(101), ip: '1.1.1.3' }, NOW), /too_long/);
  assert.equal(list().length, 1);
});

test('上下文清洗：不认识的值一律清掉', async () => {
  fresh();
  await F.addFeedback({ text: 'x', ctx: { tab: '<x>', ver: 'abc', standalone: 'yes', w: 1e9, extra: 'drop' }, ip: '1.1.1.4' }, NOW);
  assert.deepEqual(list()[0].ctx, { tab: '', ver: '', standalone: false, w: 10000 });
});

test('最多保留 500 条，丢最旧的', async () => {
  fresh();
  store.set('feedback:list', Array.from({ length: 500 }, (_, i) => ({ id: 'old' + i, at: i, text: 't', contact: '', ctx: {} })));
  await F.addFeedback({ text: '新的', ip: '1.1.1.5' }, NOW);
  assert.equal(list().length, 500);
  assert.equal(list()[0].text, '新的');
  assert.ok(!list().some(x => x.id === 'old499'));
});

test('并发提交不丢（写入串行）', async () => {
  fresh(); slow = true;
  await Promise.all(Array.from({ length: 20 }, (_, i) => F.addFeedback({ text: 'msg' + i, ip: '2.2.2.' + i }, NOW)));
  const l = list();
  assert.equal(l.length, 20);
  assert.equal(new Set(l.map(x => x.id)).size, 20);
  for (let i = 0; i < 20; i++) assert.ok(l.some(x => x.text === 'msg' + i), 'msg' + i);
});

test('限流：同一 IP 每小时 5 条，第 6 条 429；别的 IP 不受影响；一小时后恢复', async () => {
  fresh();
  for (let i = 0; i < 5; i++) await F.addFeedback({ text: 'n' + i, ip: '3.3.3.3' }, NOW + i);
  await assert.rejects(F.addFeedback({ text: 'n5', ip: '3.3.3.3' }, NOW + 10), e => e.code === 429 && e.message === 'rate_limited' && e.retryAfter > 0);
  await F.addFeedback({ text: 'other', ip: '4.4.4.4' }, NOW + 10);
  await F.addFeedback({ text: 'later', ip: '3.3.3.3' }, NOW + 3600e3 + 1);
  assert.equal(list().length, 7);
});

test('校验失败不占配额', async () => {
  fresh();
  for (let i = 0; i < 10; i++) await assert.rejects(F.addFeedback({ text: ' ', ip: '5.5.5.5' }, NOW));
  for (let i = 0; i < 5; i++) await F.addFeedback({ text: 'ok' + i, ip: '5.5.5.5' }, NOW);
  assert.equal(list().length, 5);
});

test('存储故障 503：不改存储，配额退回', async () => {
  fresh();
  store.set('feedback:list', [{ id: 'keep', at: 1, text: 'old', contact: '', ctx: {} }]);
  failGet = true;
  await assert.rejects(F.addFeedback({ text: 'a', ip: '6.6.6.6' }, NOW), e => e.code === 503 && e.message === 'storage_unavailable');
  failGet = false; failSet = true;
  await assert.rejects(F.addFeedback({ text: 'b', ip: '6.6.6.6' }, NOW), e => e.code === 503);
  failSet = false;
  assert.deepEqual(list().map(x => x.id), ['keep']);
  for (let i = 0; i < 5; i++) await F.addFeedback({ text: 'c' + i, ip: '6.6.6.6' }, NOW);   // 配额完整
  assert.equal(list().length, 6);
});

test('启动时载入失败：之后提交不覆盖存储里的历史', async () => {
  fresh();
  store.set('feedback:list', [1, 2, 3].map(i => ({ id: 'h' + i, at: i, text: 'h', contact: '', ctx: {} })));
  failGet = true; await F.loadFeedback(); failGet = false;
  assert.equal(F.feedbackLoaded(), false);
  await F.addFeedback({ text: 'new', ip: '7.7.7.7' }, NOW);
  assert.equal(list().length, 4);
});

let boss, alice;
test('只给管理员看：最新在前，含联系方式；非管理员和未登录 404', async () => {
  fresh();
  boss = (await A.register({ name: 'boss', password: 'longpassword', invite: 'invite-code-1' })).user.id;
  alice = (await A.register({ name: 'alice', password: 'longpassword', invite: 'invite-code-1' })).user.id;
  A._reset(); await A.initAccounts();   // 管理员只认启动时已存在的账号
  await F.addFeedback({ text: 'first', contact: 'me@x', ip: '8.8.8.1' }, NOW);
  await F.addFeedback({ text: 'second', ip: '8.8.8.2' }, NOW + 1);
  const r = F.feedbackList(boss);
  assert.equal(r.total, 2); assert.deepEqual(r.items.map(x => x.text), ['second', 'first']);
  assert.equal(r.items[1].contact, 'me@x');
  for (const u of [alice, null, undefined]) assert.throws(() => F.feedbackList(u), e => e.code === 404 && e.message === 'not found');
});

test('不存 IP：条目只有约定的字段', async () => {
  fresh();
  await F.addFeedback({ text: 'x', contact: 'y', ctx, user: 'alice', ip: '9.8.7.6' }, NOW);
  const it = list()[0];
  assert.deepEqual(Object.keys(it).sort(), ['at', 'contact', 'ctx', 'id', 'text', 'user']);
  assert.deepEqual(Object.keys(it.ctx).sort(), ['standalone', 'tab', 'ver', 'w']);
  assert.ok(!JSON.stringify(list()).includes('9.8.7.6'));
});

test('FEEDBACK=0 关闭', async () => {
  fresh();
  process.env.FEEDBACK = '0';
  assert.equal(F.feedbackOn(), false);
  await assert.rejects(F.addFeedback({ text: 'x', ip: '1.2.3.4' }, NOW), e => e.code === 404);
  delete process.env.FEEDBACK;
  assert.equal(F.feedbackOn(), true);
});
