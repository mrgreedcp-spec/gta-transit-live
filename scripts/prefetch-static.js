// 构建阶段预下载全部机构的静态 GTFS，避免云端冷启动时再下载。
// 单个机构失败只警告，始终 exit 0（Durham 等源偶尔 502，不能卡住构建）。
import { AGENCIES } from '../server/agencies.js';
import { loadStatic, staticStatus } from '../server/static.js';

const t0 = Date.now();
const queue = AGENCIES.filter(a => a.enabled && a.staticUrl);
await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) await loadStatic(queue.shift()); }));
for (const a of AGENCIES) {
  const s = staticStatus(a.id);
  console.log(`[prefetch] ${a.id}: ${s.state} stops=${s.stops ?? 0}${s.error ? ' error=' + s.error : ''}`);
}
console.log(`[prefetch] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
