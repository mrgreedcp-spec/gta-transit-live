import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestDue, digestLastCall, buildDigest, cleanDigest } from '../server/digest.js';

const st = n => Array.from({ length: n }, (_, i) => ({ agency: 'miway', id: String(i), name: `站${i}` }));
const D = { enabled: true, at: '07:30', days: [1, 2, 3, 4, 5], stops: st(2), lastDate: null };
const T = (hm, day = 1, date = '2026-11-16') => ({ hm, day, date });

test('到点、宽限内、跨天才发', () => {
  assert.equal(digestDue(D, T('07:29')), false);
  assert.equal(digestDue(D, T('07:30')), true);
  assert.equal(digestDue(D, T('09:00')), true);
  assert.equal(digestDue(D, T('09:01')), false);           // 过了 90 分钟宽限
  assert.equal(digestDue(D, T('07:30', 0)), false);       // 周日不在 days
  assert.equal(digestDue({ ...D, lastDate: '2026-11-16' }, T('07:40')), false);
  assert.equal(digestDue({ ...D, lastDate: '2026-11-15' }, T('07:40')), true);
  assert.equal(digestDue({ ...D, enabled: false }, T('07:40')), false);
  assert.equal(digestDue({ ...D, stops: [] }, T('07:40')), false);
  assert.equal(digestLastCall(D, T('08:54')), false);
  assert.equal(digestLastCall(D, T('08:55')), true);
});

test('拼接：下两班、没车写 —、超 8 站', () => {
  const now = 1000;
  const arr = new Map([['miway:0', [{ routeShort: '9', time: 1180 }, { routeShort: '48', time: 1720 }, { routeShort: '9', time: 2000 }]],
    ['miway:1', [{ routeShort: '38', time: 990 }]]]);
  const r = buildDigest(st(2), arr, now, '07:30');
  assert.equal(r.title, '收藏站点 07:30');
  assert.equal(r.body, '站0：9 3分 · 48 12分\n站1：38 即到');
  assert.equal(r.empty, false);
  const e = buildDigest(st(9), new Map(), now, '07:31');
  assert.equal(e.empty, true);
  assert.equal(e.body.split('\n').length, 9);
  assert.match(e.body, /站7：—\n等 1 站$/);
  assert.equal(buildDigest([], new Map(), now, '07:30').body, '');
});

test('校验设置', () => {
  const c = cleanDigest({ enabled: true, at: '25:00', days: [1, 1, 9, '2'], stops: [{ agency: 'miway', id: '1', name: 'x'.repeat(100) }, { id: '2' }] });
  assert.equal(c.at, '07:30');
  assert.deepEqual(c.days, [1, 2]);
  assert.equal(c.stops.length, 1);
  assert.equal(c.stops[0].name.length, 80);
  assert.equal(cleanDigest({ days: [] }), null);
  // 只同步收藏：保留原来的开关、时间、lastDate
  const old = { enabled: true, at: '08:00', days: [0], stops: [], lastDate: '2026-11-16' };
  const s = cleanDigest({ stops: st(1) }, old);
  assert.deepEqual([s.enabled, s.at, s.days, s.lastDate, s.stops.length], [true, '08:00', [0], '2026-11-16', 1]);
});
