// 集解析回归测试（v4；v6 起存储为 eps:v1 整表、过期靠条目 exp）：
// 全部 fetch 打桩：一部夹具剧（TVmaze 70001 → TMDB 88001「夹具剧」）
// 在 web 排期里有 4 集，TMDB 集详情分别造：
//   e1 集名+简介都有中文   → 两字段都被中文覆盖，正结果入 eps:v1（exp 30 天）
//   e2 只有集名有中文、简介为空 → 只覆盖集名，简介保持 TVmaze 原值；
//        至少一字段有中文仍算正结果，入 eps:v1（exp 30 天）
//   e3 全程 429（瞬时失败） → transient：不入表、字段保持原值，下轮重试
//   e4 有结论但全英文      → 负结果入 eps:v1（exp 7 天），字段保持原值
// 第二轮同一 env 再跑：e1/e2/e4 的集详情零 TMDB 调用（缓存命中），
// 只有 e3 因 transient 未落盘被重新调用；快照里中文照旧（缓存 seed 回填）。
// 用法：node scripts/test_episode.mjs
import { aggregate } from '../src/index.js';

class MemoryKV {
  constructor() {
    this.map = new Map();
    this.ttls = new Map();
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
  async put(key, value, opts) {
    this.map.set(key, String(value));
    if (opts?.expirationTtl) this.ttls.set(key, opts.expirationTtl);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

const jsonResp = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const SHOW = {
  id: 70001,
  name: 'Fixture Show',
  image: null,
  network: { name: 'FixNet', country: { code: 'US', name: 'United States' } },
  webChannel: null,
  externals: { imdb: 'tt7000001' },
  summary: '<p>Fixture show summary</p>',
};

const EP_FIXTURES = [
  { id: 101, name: 'Alpha', number: 1, summary: '<p>Original summary A</p>' },
  { id: 102, name: 'Beta', number: 2, summary: '<p>Original summary B</p>' },
  { id: 103, name: 'Gamma', number: 3, summary: '<p>Original summary C</p>' },
  { id: 104, name: 'Delta', number: 4, summary: '<p>Original summary D</p>' },
];

const scheduleEntry = (f) => ({
  id: f.id,
  name: f.name,
  season: 1,
  number: f.number,
  airdate: '2026-11-10',
  airtime: '21:00',
  airstamp: '2026-11-10T13:00:00+00:00',
  summary: f.summary,
  show: SHOW,
});

// TMDB 调用计数：集详情按集号分开数，find 单独数（验第二轮剧名缓存命中）
const epCalls = { 1: 0, 2: 0, 3: 0, 4: 0 };
let findCalls = 0;

globalThis.fetch = (url) => {
  const u = new URL(String(url));
  const host = u.hostname;
  const path = u.pathname;
  if (host === 'api.tvmaze.com') {
    if (path === '/schedule/web') {
      return Promise.resolve(jsonResp(EP_FIXTURES.map(scheduleEntry)));
    }
    if (path === '/schedule') return Promise.resolve(jsonResp([]));
    if (path.startsWith('/shows/')) return Promise.resolve(jsonResp([]));
  }
  if (host === 'api.bgm.tv') return Promise.resolve(jsonResp([]));
  if (host === 'api.themoviedb.org') {
    if (path.startsWith('/3/find/')) {
      findCalls++;
      return Promise.resolve(jsonResp({ tv_results: [{ id: 88001 }] }));
    }
    const epMatch = path.match(/^\/3\/tv\/88001\/season\/1\/episode\/(\d+)$/);
    if (epMatch) {
      const n = Number(epMatch[1]);
      epCalls[n]++;
      if (n === 1) {
        return Promise.resolve(
          jsonResp({ name: '第一集标题', overview: '第一集的中文简介' })
        );
      }
      if (n === 2) {
        return Promise.resolve(jsonResp({ name: '第二集标题', overview: '' }));
      }
      if (n === 3) {
        return Promise.resolve(jsonResp({ status_message: 'rate limited' }, 429));
      }
      if (n === 4) {
        return Promise.resolve(
          jsonResp({ name: 'English Only', overview: 'English overview only' })
        );
      }
    }
    if (path === '/3/tv/88001') {
      return Promise.resolve(
        jsonResp({ name: '夹具剧', poster_path: '/p.jpg', overview: '夹具剧简介' })
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
  CACHE: new MemoryKV(),
  TMDB_TOKEN: 'fake-token-for-episode-test',
  REFRESH_KEY: null,
};

async function snapshotEntries(env, stats) {
  const firstDay = Object.keys(stats.days)[0];
  const snap = await env.CACHE.get(`day:${firstDay}`, { type: 'json' });
  return snap.entries.filter((e) => e.source === 'tvmaze-schedule');
}

console.log('== hbcalendar episode test (v4) ==');

// ---- 第一轮：冷缓存 ----
console.log('\n第一轮（冷缓存）：');
const stats1 = await aggregate(env);
console.log(
  `  stats: episodeResolved=${stats1.episodeResolved} episodeResolvedThisRun=${stats1.episodeResolvedThisRun} episodeRemain=${stats1.episodeRemain}`
);
check('episodeResolvedThisRun === 3（e1/e2/e4 有结论）', stats1.episodeResolvedThisRun === 3);
check('episodeResolved === 3', stats1.episodeResolved === 3);
check('episodeRemain === 1（只有 429 的 e3）', stats1.episodeRemain === 1);

const entries1 = await snapshotEntries(env, stats1);
const byEp = Object.fromEntries(entries1.map((e) => [e.episode, e]));
check('剧名已解析为中文（前置条件）', byEp[1]?.showTitle === '夹具剧', byEp[1]?.showTitle);
check(
  'e1 集名被中文覆盖',
  byEp[1]?.episodeTitle === '第一集标题',
  byEp[1]?.episodeTitle
);
check(
  'e1 集简介被中文覆盖',
  byEp[1]?.overview === '第一集的中文简介',
  byEp[1]?.overview
);
check(
  'e2 只覆盖集名、简介保持 TVmaze 原值',
  byEp[2]?.episodeTitle === '第二集标题' && byEp[2]?.overview === 'Original summary B',
  `${byEp[2]?.episodeTitle} / ${byEp[2]?.overview}`
);
check(
  'e3（429）字段保持原值',
  byEp[3]?.episodeTitle === 'Gamma' && byEp[3]?.overview === 'Original summary C',
  `${byEp[3]?.episodeTitle} / ${byEp[3]?.overview}`
);
check(
  'e4（有结论全英文）字段保持原值',
  byEp[4]?.episodeTitle === 'Delta' && byEp[4]?.overview === 'Original summary D',
  `${byEp[4]?.episodeTitle} / ${byEp[4]?.overview}`
);
const epsTable1 = await env.CACHE.get('eps:v1', { type: 'json' });
const expInDays = (e, days) =>
  typeof e?.exp === 'number' &&
  e.exp > Date.now() + (days - 1) * 86400000 &&
  e.exp < Date.now() + (days + 1) * 86400000;
check(
  'e1 正结果入 eps:v1 整表、exp 30 天',
  expInDays(epsTable1?.['ep:88001:1:1'], 30)
);
check(
  'e2 正结果入 eps:v1 整表、exp 30 天（一字段中文即正结果）',
  expInDays(epsTable1?.['ep:88001:1:2'], 30)
);
check('e3（429 transient）不入表', !epsTable1?.['ep:88001:1:3']);
check(
  'e4 负结果入 eps:v1 整表、exp 7 天',
  expInDays(epsTable1?.['ep:88001:1:4'], 7)
);
check('e3 本轮确有被调用（计数 > 0）', epCalls[3] > 0, `calls=${epCalls[3]}`);

// ---- 第二轮：同一 env，缓存命中 ----
console.log('\n第二轮（同 env，验缓存命中）：');
for (const k of Object.keys(epCalls)) epCalls[k] = 0;
findCalls = 0;
const stats2 = await aggregate(env);
console.log(
  `  stats: episodeResolved=${stats2.episodeResolved} episodeResolvedThisRun=${stats2.episodeResolvedThisRun} episodeRemain=${stats2.episodeRemain}`
);
check(
  'e1/e2/e4 集详情零 TMDB 调用（缓存命中）',
  epCalls[1] === 0 && epCalls[2] === 0 && epCalls[4] === 0,
  JSON.stringify(epCalls)
);
check(
  'e3 因 transient 未落盘被重新调用（设计如此）',
  epCalls[3] > 0,
  `calls=${epCalls[3]}`
);
check('剧名 find 零调用（names:v2 整表命中）', findCalls === 0, `calls=${findCalls}`);
check(
  '第二轮 episodeResolvedThisRun === 0、episodeResolved === 3、episodeRemain === 1',
  stats2.episodeResolvedThisRun === 0 &&
    stats2.episodeResolved === 3 &&
    stats2.episodeRemain === 1
);
const entries2 = await snapshotEntries(env, stats2);
const byEp2 = Object.fromEntries(entries2.map((e) => [e.episode, e]));
check(
  '第二轮快照 e1 仍是中文集名+中文简介（缓存 seed 回填）',
  byEp2[1]?.episodeTitle === '第一集标题' && byEp2[1]?.overview === '第一集的中文简介'
);
check(
  '第二轮快照 e2 仍只覆盖集名',
  byEp2[2]?.episodeTitle === '第二集标题' && byEp2[2]?.overview === 'Original summary B'
);

console.log(failures === 0 ? '\n== ALL PASS ==' : `\n== ${failures} FAILURES ==`);
process.exit(failures === 0 ? 0 : 1);
