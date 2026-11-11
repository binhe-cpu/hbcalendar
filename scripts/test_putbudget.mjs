// put 预算回归测试（v6 省写）：
// 背景：Cloudflare KV 免费套餐每日 put 上限 1000 次，旧版每轮写
// 150–250 次、48 轮/天必爆（2026-11-10 官方通知实锤）。v6 整表化
// + 检查点收敛 + 快照跳写 + diag 刷盘节流后，预算为：稳态轮
// ≤ 约 17 次、追赶轮 ≤ 约 30 次。本测试用计数 KV 桩实测：
//   第一轮（冷缓存）：48 部夹具剧（两天各 24 部、每部 1 集），
//     TMDB 打桩全部中文命中——断言本轮 put 总数 ≤ 30、names:v2
//     与 eps:v1 各 put ≤ 2 次、无任何逐条键（showname2: / ep:{id}）
//     被写、剧名与集都真实解析了（resolvedThisRun /
//     episodeResolvedThisRun 有量）；
//   第二轮（同 env 全缓存命中）：断言 put 总数 ≤ 17、day:* put
//     为 0（跳写生效：开局回填使三版快照内容一致）、names:v2 /
//     eps:v1 put 为 0（不 dirty 不写）、TMDB 基本零调用。
// 用法：node scripts/test_putbudget.mjs
import { aggregate } from '../src/index.js';

class CountingKV {
  constructor() {
    this.map = new Map();
    this.puts = [];
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
    this.puts.push(String(key));
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
  countPut(pred) {
    return this.puts.filter(pred).length;
  }
}

const jsonResp = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// 与 src 的 next7Days 同口径算出未来 7 天（Asia/Shanghai）
function next7Days() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = fmt.format(new Date());
  const base = new Date(`${today}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < 7; i++) {
    out.push(new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}
const DAYS = next7Days();

const SHOW_COUNT = 48; // 两天各 24 部
const makeShow = (i) => ({
  id: 20001 + i,
  name: `Budget Show ${i}`,
  image: null,
  network: { name: 'BudgetNet', country: { code: 'US', name: 'United States' } },
  webChannel: null,
  externals: { imdb: `tt${20001 + i}` },
  summary: '<p>budget show summary</p>',
});
const entryFor = (i, date) => ({
  id: 50000 + i,
  name: 'Budget Episode',
  season: 1,
  number: 1,
  airdate: date,
  airtime: '21:00',
  airstamp: `${date}T13:00:00+00:00`,
  summary: '<p>budget episode summary</p>',
  show: makeShow(i),
});

let tmdbCalls = 0;
globalThis.fetch = (url) => {
  const u = new URL(String(url));
  const host = u.hostname;
  const path = u.pathname;
  if (host === 'api.tvmaze.com') {
    if (path === '/schedule/web') {
      const date = u.searchParams.get('date');
      if (date === DAYS[0]) {
        return Promise.resolve(
          jsonResp(Array.from({ length: 24 }, (_, k) => entryFor(k, date)))
        );
      }
      if (date === DAYS[1]) {
        return Promise.resolve(
          jsonResp(Array.from({ length: 24 }, (_, k) => entryFor(24 + k, date)))
        );
      }
      return Promise.resolve(jsonResp([]));
    }
    if (path === '/schedule') return Promise.resolve(jsonResp([]));
    if (path.startsWith('/shows/')) return Promise.resolve(jsonResp([]));
  }
  if (host === 'api.bgm.tv') return Promise.resolve(jsonResp([]));
  if (host === 'api.themoviedb.org') {
    tmdbCalls++;
    const find = path.match(/^\/3\/find\/tt(\d+)$/);
    if (find) {
      const idx = Number(find[1]) - 20001;
      return Promise.resolve(jsonResp({ tv_results: [{ id: 30000 + idx }] }));
    }
    const ep = path.match(/^\/3\/tv\/(\d+)\/season\/1\/episode\/1$/);
    if (ep) {
      return Promise.resolve(
        jsonResp({ name: '第一集中文名', overview: '第一集中文简介' })
      );
    }
    const tv = path.match(/^\/3\/tv\/(\d+)$/);
    if (tv) {
      return Promise.resolve(
        jsonResp({ name: `中文剧${tv[1]}`, poster_path: '/p.jpg', overview: '中文简介' })
      );
    }
  }
  return Promise.reject(new Error(`unexpected fetch: ${url}`));
};

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const env = {
  CACHE: new CountingKV(),
  TMDB_TOKEN: 'fake-token-for-putbudget-test',
  REFRESH_KEY: null,
};

console.log('== hbcalendar put budget test (v6) ==');

// ---- 第一轮：冷缓存追赶轮 ----
console.log('\n第一轮（冷缓存，48 部新剧名 + 48 集待解析）：');
const t0 = Date.now();
const stats1 = await aggregate(env);
const elapsed1 = Date.now() - t0;
const puts1 = [...env.CACHE.puts];
console.log(
  `  stats: ${elapsed1} ms resolvedThisRun=${stats1.resolvedThisRun} episodeResolvedThisRun=${stats1.episodeResolvedThisRun} remain=${stats1.remainUnresolved} episodeRemain=${stats1.episodeRemain}`
);
const byPrefix = {};
for (const k of puts1) {
  const p = k.startsWith('day:') ? 'day:*' : k;
  byPrefix[p] = (byPrefix[p] ?? 0) + 1;
}
console.log(`  put 明细：${JSON.stringify(byPrefix)}，总计 ${puts1.length}`);
check('剧名真实解析（resolvedThisRun ≥ 45）', stats1.resolvedThisRun >= 45, `${stats1.resolvedThisRun}`);
check('集真实解析（episodeResolvedThisRun ≥ 42）', stats1.episodeResolvedThisRun >= 42, `${stats1.episodeResolvedThisRun}`);
check('本轮 put 总数 ≤ 30', puts1.length <= 30, `${puts1.length}`);
check("names:v2 put ≤ 2 次", env.CACHE.countPut((k) => k === 'names:v2') <= 2, `${env.CACHE.countPut((k) => k === 'names:v2')}`);
check("eps:v1 put ≤ 2 次", env.CACHE.countPut((k) => k === 'eps:v1') <= 2, `${env.CACHE.countPut((k) => k === 'eps:v1')}`);
check(
  '无逐条键被写（showname2: / ep:{id} 均为 0）',
  !puts1.some((k) => k.startsWith('showname') || /^ep:\d/.test(k))
);
const namesTable = await env.CACHE.get('names:v2', { type: 'json' });
const epsTable = await env.CACHE.get('eps:v1', { type: 'json' });
check('names:v2 整表条目 ≥ 45', Object.keys(namesTable ?? {}).length >= 45, `${Object.keys(namesTable ?? {}).length}`);
check('eps:v1 整表条目 ≥ 42', Object.keys(epsTable ?? {}).length >= 42, `${Object.keys(epsTable ?? {}).length}`);

// ---- 第二轮：同 env，缓存全命中稳态轮 ----
console.log('\n第二轮（全缓存命中稳态轮）：');
env.CACHE.puts.length = 0;
tmdbCalls = 0;
const stats2 = await aggregate(env);
const puts2 = [...env.CACHE.puts];
const byPrefix2 = {};
for (const k of puts2) {
  const p = k.startsWith('day:') ? 'day:*' : k;
  byPrefix2[p] = (byPrefix2[p] ?? 0) + 1;
}
console.log(`  put 明细：${JSON.stringify(byPrefix2)}，总计 ${puts2.length}；TMDB 调用 ${tmdbCalls} 次`);
check('本轮 put 总数 ≤ 17', puts2.length <= 17, `${puts2.length}`);
check(
  'day:* put 为 0（快照跳写生效）',
  env.CACHE.countPut((k) => k.startsWith('day:')) === 0,
  `${env.CACHE.countPut((k) => k.startsWith('day:'))}`
);
check("names:v2 put 为 0（不 dirty 不写）", env.CACHE.countPut((k) => k === 'names:v2') === 0);
check("eps:v1 put 为 0（不 dirty 不写）", env.CACHE.countPut((k) => k === 'eps:v1') === 0);
check('TMDB 基本零调用（整表全命中）', tmdbCalls <= 4, `${tmdbCalls}`);
check('第二轮 remainUnresolved === 0', stats2.remainUnresolved === 0, `${stats2.remainUnresolved}`);

console.log(failures === 0 ? '\n== ALL PASS ==' : `\n== ${failures} FAILURES ==`);
process.exit(failures === 0 ? 0 : 1);
