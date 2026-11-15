import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UA = 'gta-transit-live/0.1 (personal use)';

export async function fetchBuffer(url, timeoutMs = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// 流式下载到 dest.part，完成后改名，避免半截文件。
export async function downloadTo(url, dest, timeoutMs = 300000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest + '.part'));
  await rename(dest + '.part', dest);
}

export function errMsg(e) {
  const c = e?.cause;
  return (c?.code || c?.message || e?.name === 'TimeoutError' && 'timeout' || e?.message || String(e)).toString();
}
