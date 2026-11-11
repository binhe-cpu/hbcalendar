// 时间盒回归测试（v2）：
// - global fetch 打桩：api.themoviedb.org 每次调用固定延迟 30 秒，
//   且遵循 AbortSignal（与真实 fetch 一致——tmdbFetch 的 10s 超时会
//   把它掐断、走一次重试，所以单个 TMDB 请求实际耗时约 2×10s+退避）。
//   TVmaze / Bangumi 走真实网络。
// - TMDB_TOKEN 设假值，启用 TMDB 步；内存 KV 桩，冷缓存起跑。
// 断言：
//   1. aggregate() 在 100 秒内返回（时间盒生效，没被慢 TMDB 拖死）；
//   2. 7 天的 day: 快照都已落 KV（检查点在补名跑完前就写了）；
//   3. stats.partial === true 且 remainUnresolved > 0（到点停、余量留下轮）。
// 用法：node scripts/test_timebox.mjs
import { aggregate } from '../src/index.js';

class MemoryKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, opts) {
    const v = this.map.get(key);
    if (v == null) return null;
    if (opts && opts.type === 'json') {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}

// ---- fetch 打桩：TMDB 固定慢 30s（可被 AbortSignal 掐断），其余真网络 ----
const realFetch = globalThis.fetch;
let tmdbCalls = 0;
globalThis.fetch = (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.themoviedb.org/')) {
    return realFetch(url, opts);
  }
  tmdbCalls++;
  const signal = opts.signal;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      // 若真熬满 30s（不该发生，10s 就会被超时掐断），给个空结果响应
      resolve(
        new Response(JSON.stringify({ results: [], tv_results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }, 30000);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
};

const env = {
  CACHE: new MemoryKV(),
  TMDB_TOKEN: 'fake-token-for-timebox-test',
  REFRESH_KEY: null,
};

console.log('== hbcalendar timebox test ==');
console.log('TMDB 打桩：每次调用延迟 30s（10s 超时掐断后重试 1 次），冷缓存起跑');

const t0 = Date.now();
const stats = await aggregate(env);
const elapsed = Date.now() - t0;

console.log(`\naggregate 返回：${elapsed} ms（TMDB 桩被调 ${tmdbCalls} 次）`);
console.log(
  `partial=${stats.partial} resolvedThisRun=${stats.resolvedThisRun} remainUnresolved=${stats.remainUnresolved} shows=${stats.showsResolved}`
);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

check('aggregate 在 100 秒内返回', elapsed < 100000, `${elapsed} ms`);

let dayKeys = 0;
for (const d of Object.keys(stats.days)) {
  const snap = await env.CACHE.get(`day:${d}`, { type: 'json' });
  if (snap && Array.isArray(snap.entries)) dayKeys++;
}
check('7 天 day: 快照全部落 KV', dayKeys === 7, `${dayKeys}/7`);

check('stats.partial === true', stats.partial === true);
check(
  'remainUnresolved > 0（未解析的留给下一轮）',
  stats.remainUnresolved > 0,
  `remain=${stats.remainUnresolved}`
);

const meta = await env.CACHE.get('meta:lastRefresh', { type: 'json' });
check('meta:lastRefresh 已写', !!meta?.at, meta?.at ?? 'null');

console.log(failures === 0 ? '\n== ALL PASS ==' : `\n== ${failures} FAILURES ==`);
process.exit(failures === 0 ? 0 : 1);
