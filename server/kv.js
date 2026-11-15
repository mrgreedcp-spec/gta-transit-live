// 简单键值存储：配置了 Upstash（UPSTASH_REDIS_REST_URL/TOKEN）就用 Redis REST API；
// 否则用本地文件 data/kv.json（本地开发可用；Render 免费版重启会清空，所以云端应配置 Upstash）。
// 只存 JSON 值，不用复杂的 Redis 结构，命令数少，适合 Upstash 免费额度（50 万条/月）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const URL_ = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const FILE = path.resolve(import.meta.dirname, '..', 'data', 'kv.json');

export const kvKind = URL_ && TOKEN ? 'upstash' : 'file';
export const kvPersistent = kvKind === 'upstash' || !process.env.RENDER;
const stats = { cmds: 0, errors: 0, lastError: null, day: '' };

async function redis(cmd) {
  const today = new Date().toISOString().slice(0, 10);
  if (stats.day !== today) { stats.day = today; stats.cmds = 0; }
  stats.cmds++;
  const r = await fetch(URL_, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { stats.errors++; stats.lastError = j.error || `HTTP ${r.status}`; throw new Error(`Upstash: ${stats.lastError}`); }
  return j.result;
}

// ---------- 文件后端 ----------
let mem = null, saveTimer = null;
async function loadFile() {
  if (mem) return mem;
  try { mem = JSON.parse(await readFile(FILE, 'utf8')); } catch { mem = {}; }
  return mem;
}
function saveFile() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(mem));
  }, 500);
}

const PREFIX = 'gta:';
export async function kvGet(key) {
  if (kvKind === 'upstash') { const v = await redis(['GET', PREFIX + key]); return v == null ? null : JSON.parse(v); }
  return (await loadFile())[key] ?? null;
}
export async function kvSet(key, value) {
  if (kvKind === 'upstash') return redis(['SET', PREFIX + key, JSON.stringify(value)]);
  (await loadFile())[key] = value; saveFile();
}
export async function kvDel(key) {
  if (kvKind === 'upstash') return redis(['DEL', PREFIX + key]);
  delete (await loadFile())[key]; saveFile();
}
export function kvStatus() { return { kind: kvKind, persistent: kvPersistent, cmdsToday: stats.cmds, errors: stats.errors, lastError: stats.lastError }; }
