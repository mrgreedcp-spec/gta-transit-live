// 每日收藏摘要：纯函数（无 IO），便于单测。push.js 负责存取和发送。
// digest = { enabled, at:'HH:MM', days:[0-6], stops:[{agency,id,name}], lastDate:'YYYY-MM-DD' }
export const MAX_LINES = 8, MAX_STOPS = 30, GRACE_MIN = 90;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = hm => +hm.slice(0, 2) * 60 + +hm.slice(3);

// t = { day:0-6, hm:'HH:MM', date:'YYYY-MM-DD' }（多伦多时间）。到点后 graceMin 分钟内都算该发（服务器休眠醒来补发）。
export function digestDue(d, t, graceMin = GRACE_MIN) {
  if (!d?.enabled || !d.stops?.length || !d.days?.includes(t.day) || d.lastDate === t.date) return false;
  const late = toMin(t.hm) - toMin(d.at);
  return late >= 0 && late <= graceMin;
}

// 最后几分钟：数据还空也照发
export const digestLastCall = (d, t, graceMin = GRACE_MIN) => toMin(t.hm) - toMin(d.at) >= graceMin - 5;

// arrivalsByKey: 'agency:id' -> [{routeShort, time}]；与收藏页「下两班」写法一致
export function buildDigest(stops, arrivalsByKey, nowS, hm) {
  let empty = true;
  const lines = stops.slice(0, MAX_LINES).map(s => {
    const list = (arrivalsByKey.get(`${s.agency}:${s.id}`) || []).filter(a => a.time - nowS >= -30).slice(0, 2);
    if (list.length) empty = false;
    const txt = list.map(a => { const m = Math.round((a.time - nowS) / 60); return `${a.routeShort} ${m <= 0 ? '即到' : m + '分'}`; }).join(' · ');
    return `${s.name}：${txt || '—'}`;
  });
  if (stops.length > MAX_LINES) lines.push(`等 ${stops.length - MAX_LINES} 站`);
  return { title: `收藏站点 ${hm}`, body: lines.join('\n'), empty };
}

// 校验、归一化客户端传来的设置；返回 null 表示不合法
export function cleanDigest(x = {}, old = null) {
  const at = HHMM.test(x.at) ? x.at : old?.at || '07:30';
  const days = Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : old?.days || [0, 1, 2, 3, 4, 5, 6];
  const stops = (Array.isArray(x.stops) ? x.stops : old?.stops || []).slice(0, MAX_STOPS)
    .map(s => ({ agency: String(s?.agency || '').slice(0, 20), id: String(s?.id || '').slice(0, 40), name: String(s?.name || '').slice(0, 80) }))
    .filter(s => s.agency && s.id);
  if (!days.length) return null;
  return { enabled: x.enabled === undefined ? !!old?.enabled : !!x.enabled, at, days, stops, lastDate: old?.lastDate || null };
}
