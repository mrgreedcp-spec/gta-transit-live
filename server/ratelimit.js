// 内存令牌桶限流。key = 类别:身份（IP 或用户）。
const BUCKETS = new Map();
const RULES = {
  api: { cap: 90, rate: 1.5 },     // 一般接口
  plan: { cap: 5, rate: 1 / 20 },  // 路线规划
  geo: { cap: 20, rate: 0.5 },     // 地名搜索
  write: { cap: 10, rate: 0.2 },   // 写操作（推送规则、订阅）
  login: { cap: 5, rate: 1 / 120 }, // 改密码（每 2 分钟回 1 次）
};

export function clientKey(req) {
  return (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?');
}

// 返回 0 = 放行；否则返回需要等待的秒数
export function take(kind, who) {
  const r = RULES[kind] || RULES.api;
  const k = `${kind}:${who}`;
  const now = Date.now() / 1000;
  let b = BUCKETS.get(k);
  if (!b) { b = { t: r.cap, at: now }; BUCKETS.set(k, b); }
  b.t = Math.min(r.cap, b.t + (now - b.at) * r.rate);
  b.at = now;
  if (b.t >= 1) { b.t -= 1; return 0; }
  return Math.ceil((1 - b.t) / r.rate);
}

setInterval(() => { // 清理闲置的桶
  const now = Date.now() / 1000;
  for (const [k, b] of BUCKETS) if (now - b.at > 600) BUCKETS.delete(k);
}, 60000).unref();
