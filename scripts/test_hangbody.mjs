// body 挂死回归测试（v5-diag）：
// 背景：v5 部署后连续多轮 cron 在补名阶段初期无声冻结——第一版检查点
// 写出后 meta 几十分钟不再更新，按 50 秒时间盒本应写出的最终版始终
// 不出现。候选挂点之一是 resp.json() 的 body 读取：AbortSignal.timeout
// 只管到响应头，body 流迟迟读不完时 await resp.json() 可以永远挂住，
// 把整个聚合 promise 冻死。v5-diag 给 body 读取加了 10 秒超时赛跑：
// 本测试把 TMDB 的 fetch 打桩成「响应头正常 200、resp.json() 永不
// 返回」，断言：
//   1. aggregate() 能在 120 秒内返回（不被单个 body 挂死整轮）；
//   2. 最终 stats 已写出（meta:lastRefresh 在），jsonTimeouts > 0，
//      且 paceTimeouts / kvTimeouts 均为 0（本场景节流链与 KV 都健康，
//      看门狗不许误报）；partial=true、remainUnresolved > 0（挂死的
//      show 都按失败/未完成处理、留给下一轮）；
//   3. meta:diag 已落盘：phase=final、todoCount > 0、fetchStarted > 0、
//      paceIn === paceOut（进出节流链的都出来了）、jsonTimeouts 与
//      stats 一致且 > 0；
//   4. 7 天 day: 快照齐全（检查点机制没被护栏打断）。
// TVmaze / Bangumi 走真实网络（与 test_timebox 同口径）。
// 用法：node scripts/test_hangbody.mjs
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

// ---- fetch 打桩：TMDB 返回「头到、body 永不读完」的响应 ----
const realFetch = globalThis.fetch;
let tmdbCalls = 0;
globalThis.fetch = (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.themoviedb.org/')) {
    return realFetch(url, opts);
  }
  tmdbCalls++;
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => new Promise(() => {}), // body 永远读不完
  });
};

const env = {
  CACHE: new MemoryKV(),
  TMDB_TOKEN: 'fake-token-for-hangbody-test',
  REFRESH_KEY: null,
};

console.log('== hbcalendar hangbody test (v5-diag) ==');
console.log('TMDB 打桩：响应 200 但 resp.json() 永不返回，冷缓存起跑');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 外层看门狗：aggregate 若真挂死，150 秒后放弃等待并按失败收场
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
const elapsed = Date.now() - t0;

console.log(
  `\naggregate ${stats ? `返回：${elapsed} ms` : `未在 150 秒内返回`}（TMDB 桩被调 ${tmdbCalls} 次）`
);
if (stats) {
  console.log(
    `partial=${stats.partial} remainUnresolved=${stats.remainUnresolved} jsonTimeouts=${stats.jsonTimeouts} paceTimeouts=${stats.paceTimeouts} kvTimeouts=${stats.kvTimeouts} diagPhase=${stats.diagPhase}`
  );
}

check('aggregate 在 120 秒内返回（没被 body 挂死）', stats != null && elapsed < 120000, `${elapsed} ms`);
check('aggregate 没有抛异常', aggErr == null, aggErr ? String(aggErr) : '');
check('stats.jsonTimeouts > 0（body 超时被计数）', (stats?.jsonTimeouts ?? 0) > 0, `jsonTimeouts=${stats?.jsonTimeouts}`);
check('stats.paceTimeouts === 0（节流链健康、看门狗不误报）', stats?.paceTimeouts === 0, `paceTimeouts=${stats?.paceTimeouts}`);
check('stats.kvTimeouts === 0（KV 健康）', stats?.kvTimeouts === 0, `kvTimeouts=${stats?.kvTimeouts}`);
check('stats.partial === true（到点停）', stats?.partial === true);
check('stats.remainUnresolved > 0（未完成的留给下一轮）', (stats?.remainUnresolved ?? 0) > 0, `remain=${stats?.remainUnresolved}`);
check('stats.diagPhase === final', stats?.diagPhase === 'final', `diagPhase=${stats?.diagPhase}`);

const meta = await env.CACHE.get('meta:lastRefresh', { type: 'json' });
check('meta:lastRefresh 已写（最终版落地）', !!meta?.at, meta?.at ?? 'null');

const diag = await env.CACHE.get('meta:diag', { type: 'json' });
console.log(`\nmeta:diag: ${diag ? JSON.stringify(diag) : 'null'}`);
check('meta:diag 已落盘', !!diag);
check('diag.phase === final', diag?.phase === 'final', `phase=${diag?.phase}`);
check('diag.todoCount > 0（补名队列非空）', (diag?.todoCount ?? 0) > 0, `todo=${diag?.todoCount}`);
check('diag.fetchStarted > 0 且 fetchFinished === fetchStarted', (diag?.fetchStarted ?? 0) > 0 && diag?.fetchFinished === diag?.fetchStarted, `started=${diag?.fetchStarted} finished=${diag?.fetchFinished}`);
check('diag.paceIn === paceOut（进出节流链配平）', diag?.paceIn === diag?.paceOut, `in=${diag?.paceIn} out=${diag?.paceOut}`);
check('diag.jsonTimeouts 与 stats 一致且 > 0', diag?.jsonTimeouts === stats?.jsonTimeouts && (diag?.jsonTimeouts ?? 0) > 0, `diag=${diag?.jsonTimeouts} stats=${stats?.jsonTimeouts}`);
check('diag 内部字段未落盘（无 env / 无下划线字段）', !!diag && !('env' in diag) && !Object.keys(diag).some((k) => k.startsWith('_')));

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
