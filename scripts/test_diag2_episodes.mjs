// 集阶段预读可观测性回归测试（v5-diag2）：
// 背景：v5-diag 首轮（19:30）diag 冻在 phase=episodes / updatedAt=
// 开局+51.0s，三超时计数全 0；复盘发现集阶段开局的 KV 预读走
// pool(epQueue, 12, kvGet)，全程无 diagTouch / 刷盘触发点、也不受
// 时间盒约束——无法区分「预读还在跑」与「isolate 已死」。
// v5-diag2 把预读改走 poolRolling（每完成记 epPreDoneCount、每 10 个
// 刷一版，取新任务 deadline+60s 宽限），epTodoCount 落盘后立即刷一版，
// 最终写包 try/catch（失败也写最小 meta、phase=final-error）。
// 本测试断言：
//   1. aggregate() 在 150 秒内返回，stats.diagPhase === 'final'；
//   2. 集预读真实发生：diag.epQueueCount > 0，且
//      epPreDoneCount === epQueueCount、epPreStopped === false；
//   3. 预读进度在运行中途就能从 KV 读到（并发轮询 meta:diag，至少
//      一次看到 0 < epPreDoneCount < epQueueCount）——这正是 v5-diag
//      缺的那一点；
//   4. 7 天 day: 快照齐全，meta:lastRefresh 已写；
//   5. 时间盒行为不变：本轮现查 0 集（预读跑完时已过 50s deadline，
//      poolRolling 立即停取），partial=true、episodeRemain>0。
// TMDB 走打桩（返回固定中文名/集名），TVmaze / Bangumi 走真实网络
// （与 test_timebox 同口径）。KV 的 ep: 读人为放慢 300ms，模拟
// 线上 KV 变慢时预读池的耗时形态。
// 用法：node scripts/test_diag2_episodes.mjs
import { aggregate } from '../src/index.diag2.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MemoryKV {
  constructor() {
    this.map = new Map();
    this.epGets = 0;
  }
  async get(key, opts) {
    if (String(key).startsWith('ep:')) {
      this.epGets++;
      await sleep(300); // 模拟 KV 变慢：集预读每读 300ms
    }
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

// ---- TMDB 打桩：固定中文结果 ----
const realFetch = globalThis.fetch;
const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return 200000 + (h % 700000);
};
globalThis.fetch = (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.themoviedb.org/')) {
    return realFetch(url, opts);
  }
  const parsed = new URL(u);
  const path = parsed.pathname; // /3/find/xxx | /3/search/tv | /3/tv/{id} | /3/tv/{id}/season/{s}/episode/{e}
  const json = (data) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(data),
    });
  if (path.startsWith('/3/find/')) {
    return json({ tv_results: [] }); // 走 search 兜底
  }
  if (path === '/3/search/tv') {
    const q = parsed.searchParams.get('query') ?? '';
    const id = hash(q);
    return json({ results: [{ id, name: q }] }); // 与查询标题全等，pickSearchResult 能选中
  }
  const ep = path.match(/^\/3\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)$/);
  if (ep) {
    return json({
      name: `第${ep[3]}集中文名`,
      overview: '本集中文简介',
    });
  }
  const tv = path.match(/^\/3\/tv\/(\d+)$/);
  if (tv) {
    return json({
      id: Number(tv[1]),
      name: `中文剧${tv[1]}`,
      overview: '中文简介',
      poster_path: '/p.jpg',
    });
  }
  return json({});
};

const kv = new MemoryKV();
const env = {
  CACHE: kv,
  TMDB_TOKEN: 'fake-token-for-diag2-test',
  REFRESH_KEY: null,
};

console.log('== hbcalendar diag2 episodes test ==');
console.log('TMDB 打桩：固定中文名；KV ep: 读各慢 300ms');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 运行中途轮询 meta:diag，捕捉预读进度是否中途可见
const midFlight = [];
const poller = setInterval(async () => {
  try {
    const d = await kv.get('meta:diag', { type: 'json' });
    if (d && d.phase === 'episodes') midFlight.push({ ...d });
  } catch { /* 轮询失败不影响主流程 */ }
}, 200);

const t0 = Date.now();
let stats = null;
let aggErr = null;
await Promise.race([
  aggregate(env)
    .then((s) => {
      stats = s;
    })
    .catch((e) => {
      aggErr = e;
    }),
  new Promise((r) => setTimeout(r, 150000)),
]);
clearInterval(poller);
const elapsed = Date.now() - t0;

console.log(
  `\naggregate ${stats ? `返回：${elapsed} ms` : '未在 150 秒内返回'}（KV ep: 读 ${kv.epGets} 次）`
);
if (stats) {
  console.log(
    `partial=${stats.partial} diagPhase=${stats.diagPhase} episodeRemain=${stats.episodeRemain} episodeResolvedThisRun=${stats.episodeResolvedThisRun}`
  );
}

check('aggregate 在 150 秒内返回', stats != null && elapsed < 150000, `${elapsed} ms`);
check('aggregate 没有抛异常', aggErr == null, aggErr ? String(aggErr) : '');
check('stats.diagPhase === final', stats?.diagPhase === 'final', `diagPhase=${stats?.diagPhase}`);

const diag = await env.CACHE.get('meta:diag', { type: 'json' });
console.log(`\nmeta:diag: ${diag ? JSON.stringify(diag) : 'null'}`);
check('meta:diag 已落盘', !!diag);
check('diag.phase === final', diag?.phase === 'final', `phase=${diag?.phase}`);
check('diag.epQueueCount > 0（集预读真实发生）', (diag?.epQueueCount ?? 0) > 0, `epQueueCount=${diag?.epQueueCount}`);
check(
  'diag.epPreDoneCount === epQueueCount（预读全部跑完）',
  (diag?.epPreDoneCount ?? -1) === (diag?.epQueueCount ?? -2),
  `preDone=${diag?.epPreDoneCount} queue=${diag?.epQueueCount}`
);
check('diag.epPreStopped === false（未触发宽限停取）', diag?.epPreStopped === false, `epPreStopped=${diag?.epPreStopped}`);
check('diag.epTodoCount > 0（冷缓存、集现查队列非空）', (diag?.epTodoCount ?? 0) > 0, `epTodoCount=${diag?.epTodoCount}`);

const sawMid = midFlight.some(
  (d) => (d.epPreDoneCount ?? 0) > 0 && (d.epPreDoneCount ?? 0) < (d.epQueueCount ?? Infinity)
);
console.log(
  `中途轮询到 episodes 阶段 diag ${midFlight.length} 次，` +
    `其中 epPreDoneCount 中间值样本：${midFlight.map((d) => d.epPreDoneCount ?? 0).join(',') || '无'}`
);
check('预读进度在运行中途可见（diag2 修复的核心）', sawMid, `samples=${midFlight.length}`);

const meta = await env.CACHE.get('meta:lastRefresh', { type: 'json' });
check('meta:lastRefresh 已写（最终版落地）', !!meta?.at, meta?.at ?? 'null');
check('stats.partial === true（到点停、现查留给下轮）', stats?.partial === true);
check(
  'stats.episodeResolvedThisRun === 0（预读跑完时已过时间盒，现查立即停取）',
  stats?.episodeResolvedThisRun === 0,
  `episodeResolvedThisRun=${stats?.episodeResolvedThisRun}`
);
check('stats.episodeRemain > 0（未解析的集留给下轮）', (stats?.episodeRemain ?? 0) > 0, `episodeRemain=${stats?.episodeRemain}`);

let dayKeys = 0;
if (stats) {
  for (const d of Object.keys(stats.days)) {
    const snap = await env.CACHE.get(`day:${d}`, { type: 'json' });
    if (snap && Array.isArray(snap.entries)) dayKeys++;
  }
}
check('7 天 day: 快照全部落 KV', dayKeys === 7, `${dayKeys}/7`);

console.log(failures === 0 ? '\n== ALL PASS ==' : `\n== ${failures} FAILURES ==`);
process.exit(failures === 0 ? 0 : 1);
