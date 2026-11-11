// 瞬时失败不落盘回归测试（v3；v6 起存储为 names:v2 整表）：
// 背景：v2 把 TMDB 的「查无此名」与「查询失败（429/超时/5xx）」都塌缩
// 成 null 一律落负缓存，曾把冷启动风暴里的偶发失败冻结 7 天（TVmaze
// 90035《The Remarried Empress》实锤）。v3 分型后断言：
//   场景一 TMDB 全程 429 → resolveShow 结果标 transient、KV 里没有
//         该 show 的缓存（下轮 cron 会重试），但本轮内存结果照常返回；
//   场景二 TMDB 全程有结论（find 命中 id、detail 返回但名无中文）→
//         负结果正常入 names:v2 整表（exp 7 天口径不变）、transient=false。
// 另顺带断言 computeShowName 的 trace 轨迹（/resolve 端点同源数据）。
// 用法：node scripts/test_resolve.mjs
import { computeShowName, resolveShow } from '../src/index.js';

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

// 90035 本尊做夹具：externals 齐全、非国产（webChannel 国家 US，无 aka 步）
const SHOW = {
  id: 90035,
  name: 'The Remarried Empress',
  externals: { imdb: 'tt39325975', thetvdb: 455351 },
  network: null,
  webChannel: { name: 'Disney+', country: { code: 'US', name: 'United States' } },
};

const jsonResp = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log('== hbcalendar resolve/transient test (v3) ==');

// ---- 场景一：TMDB 全程 429（瞬时失败）----
globalThis.fetch = (url) => {
  const u = String(url);
  if (u.startsWith('https://api.themoviedb.org/')) {
    return Promise.resolve(jsonResp({ status_message: 'rate limited' }, 429));
  }
  return Promise.reject(new Error(`unexpected fetch in scenario 1: ${u}`));
};
{
  const env = { CACHE: new MemoryKV(), TMDB_TOKEN: 'fake-token', REFRESH_KEY: null };
  console.log('\n场景一：TMDB 全程 429');
  const res = await resolveShow(env, SHOW, false, new Map(), {});
  check('结果标 transient', res.transient === true, `transient=${res.transient}`);
  check(
    '本轮内存结果照常返回（原名顶着）',
    res.title === 'The Remarried Empress' && res.via === 'none',
    `title=${res.title} via=${res.via}`
  );
  check(
    'KV 里没有 showname2:90035（旧逐条键不再写）',
    !env.CACHE.map.has('showname2:90035')
  );
  check(
    'names:v2 整表也没有落盘（transient 不入表）',
    !env.CACHE.map.has('names:v2')
  );
  check('KV 里也没有旧前缀 showname:90035', !env.CACHE.map.has('showname:90035'));
}

// ---- 场景二：TMDB 全程有结论、但确实没中文名 ----
globalThis.fetch = (url) => {
  const u = String(url);
  if (u.includes('/find/')) {
    // imdb find 直接命中 id → tvdb find 与 search 都不再走
    return Promise.resolve(jsonResp({ tv_results: [{ id: 999001 }] }));
  }
  if (u.includes('/tv/999001')) {
    // detail 有响应，但 zh-CN 名仍是英文（无中文资料）→ 有结论的负结果
    return Promise.resolve(
      jsonResp({ name: 'The Remarried Empress', poster_path: null, overview: '' })
    );
  }
  return Promise.reject(new Error(`unexpected fetch in scenario 2: ${u}`));
};
{
  const env = { CACHE: new MemoryKV(), TMDB_TOKEN: 'fake-token', REFRESH_KEY: null };
  console.log('\n场景二：TMDB 有结论但无中文名');
  const res = await resolveShow(env, SHOW, false, new Map(), {});
  check('结果不标 transient', res.transient === false, `transient=${res.transient}`);
  const namesTable = await env.CACHE.get('names:v2', { type: 'json' });
  const saved = namesTable?.['90035'];
  check('负结果已入 names:v2 整表', !!saved, saved ? `via=${saved.via}` : 'null');
  check(
    '入表内容为原名、无 TMDB 采用',
    saved?.title === 'The Remarried Empress' && saved?.via === 'none'
  );
  check(
    '入表 exp 约为 7 天后（正负结论同口径）',
    typeof saved?.exp === 'number' &&
      saved.exp > Date.now() + 6 * 86400000 &&
      saved.exp < Date.now() + 8 * 86400000,
    saved?.exp ? new Date(saved.exp).toISOString() : 'null'
  );

  // trace 轨迹（/resolve 端点的 steps 同源）：find_imdb 应为 ok、detail_name hasCjk=false
  const trace = [];
  await computeShowName(env, SHOW, false, trace);
  const find = trace.find((s) => s.step === 'find_imdb');
  const det = trace.find((s) => s.step === 'detail_name');
  check(
    'trace: find_imdb kind=ok 且只调一次 find（命中即止）',
    find?.kind === 'ok' && !trace.some((s) => s.step === 'find_tvdb') && !trace.some((s) => s.step === 'search'),
    JSON.stringify(trace.map((s) => s.step))
  );
  check('trace: detail_name 记录且 hasCjk=false', !!det && det.hasCjk === false);
}

console.log(failures === 0 ? '\n== ALL PASS ==' : `\n== ${failures} FAILURES ==`);
process.exit(failures === 0 ? 0 : 1);
