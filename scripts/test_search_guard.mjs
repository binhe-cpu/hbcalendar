// TMDB 标题搜索错配修复回归测试（v7）：
// 背景：TVmaze 78021《走马上任》（英文名 Let's Go、2026 首播、无任何
// externals）被标题搜索兜底错配到 TMDB 11932——1976 年加拿大儿童节目
// （英文名同为 Let's Go、全等命中）。剧名靠 aka 兜底正确，但假 tmdbId
// 被存下、集解析照假 id 查、海报集名全无。正主 TMDB 275297 按中文名
// 搜可命中。本测试断言 v7 两道修：
//   用例 A（78021 形状，中文搜索有正确候选）→ 中文搜索接管：
//         tmdbId=正确候选、title=中文名、via='tmdb'；英文搜索轮根本
//         没轮到（假候选 11932 的 detail 从未被调）。
//   用例 B（同 A 但中文搜索返回空）→ 落到英文轮：1976 候选被年份
//         护栏否决（trace 有 search_reject / year_mismatch）、
//         tmdbId 为空、title 走 aka；假 id 的 detail 根本没被调。
//   用例 C（英文候选年份相符、无 aka、非国产）→ 维持现行采纳行为：
//         tmdbId 照常被采纳（海报带回），无 search_reject。
//   用例 D（94262《The Confession Truth》形状）→ CN aka 三个别名
//         [杀人真相， 炬火， 自首真相]，TMDB 正条目名是第三个
//         「自首真相」：D1 搜「杀人真相」即回该条目（候选名≠查询词、
//         靠别名集判据采纳）；D2 前两词落空、第三词才命中（逐个搜）。
//         期望 tmdbId=该条目、title=自首真相（detail 中文名）。
//   用例 E（94262 真身形状，v8 isCn 漏判）→ webChannel.country=null、
//         network=null、language='Chinese'、不在 cnShowIds：isCn 必须
//         靠 language 判真，否则 aka/中文搜索整条链不跑（线上实测
//         via=none、trace 无 aka 步）；判真后完整链跑通、结果同 D。
// 内存 KV + TMDB/TVmaze 全打桩，风格照 test_resolve。
// 用法：node scripts/test_search_guard.mjs
import { computeShowName, isChineseShow } from '../src/index.js';

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

// 78021 本尊形状：无 externals、webChannel 国家 CN、2026 首播
const SHOW_CN = {
  id: 78021,
  name: "Let's Go",
  premiered: '2026-11-02',
  externals: { tvrage: null, thetvdb: null, imdb: null },
  network: null,
  webChannel: { name: 'Tencent QQ', country: { code: 'CN', name: 'China' } },
};

// 用例 C 的非国产 show：无 externals、US 网络、2025 首播
const SHOW_US = {
  id: 555001,
  name: 'Harbor Lights',
  premiered: '2025-03-01',
  externals: { tvrage: null, thetvdb: null, imdb: null },
  network: { name: 'FixNet', country: { code: 'US', name: 'United States' } },
  webChannel: null,
};

console.log('== hbcalendar search guard test (v7) ==');

// ---- 用例 A / B 共用桩：英文搜索命中 1976 假候选；中文搜索按参数变 ----
// cnResults 由每个用例在调用前设置；calledUrls 记录全部请求供断言。
let cnResults = [];
let calledUrls = [];
globalThis.fetch = (url) => {
  const u = String(url);
  calledUrls.push(u);
  if (u.startsWith('https://api.themoviedb.org/')) {
    const parsed = new URL(u);
    if (parsed.pathname === '/3/search/tv') {
      const q = parsed.searchParams.get('query');
      if (q === "Let's Go") {
        return Promise.resolve(
          jsonResp({
            results: [
              {
                id: 11932,
                name: "Let's Go",
                original_name: "Let's Go",
                first_air_date: '1976-09-01',
              },
            ],
          })
        );
      }
      if (q === '走马上任') {
        return Promise.resolve(jsonResp({ results: cnResults }));
      }
      return Promise.resolve(jsonResp({ results: [] }));
    }
    if (parsed.pathname === '/3/tv/275297') {
      return Promise.resolve(
        jsonResp({
          name: '走马上任',
          poster_path: '/zsm.jpg',
          overview: '民国时期，本是兽医的王老五意外成为伏虎县县长。',
        })
      );
    }
    if (parsed.pathname === '/3/tv/11932') {
      return Promise.resolve(
        jsonResp({
          name: "Let's Go",
          poster_path: '/old.jpg',
          overview: 'A Canadian children series from 1976.',
        })
      );
    }
    return Promise.reject(new Error(`unexpected TMDB url: ${u}`));
  }
  if (u === 'https://api.tvmaze.com/shows/78021/akas') {
    return Promise.resolve(
      jsonResp([{ name: '走马上任', country: { code: 'CN', name: 'China' } }])
    );
  }
  return Promise.reject(new Error(`unexpected fetch: ${u}`));
};

const mkEnv = () => ({
  CACHE: new MemoryKV(),
  TMDB_TOKEN: 'fake-token',
  REFRESH_KEY: null,
});

// ---- 用例 A：中文搜索返回 2026 年正确候选 ----
{
  console.log('\n用例 A：中文搜索命中正主（275297）');
  cnResults = [
    {
      id: 275297,
      name: '走马上任',
      original_name: '走马上任',
      first_air_date: '2026-11-02',
    },
  ];
  calledUrls = [];
  const trace = [];
  const res = await computeShowName(mkEnv(), SHOW_CN, true, trace);
  check('tmdbId = 正确候选 275297', res.tmdbId === 275297, `tmdbId=${res.tmdbId}`);
  check('title = 走马上任', res.title === '走马上任', `title=${res.title}`);
  check("via = 'tmdb'（来自 TMDB 而非 aka）", res.via === 'tmdb', `via=${res.via}`);
  check('海报已带回', typeof res.poster === 'string' && res.poster.endsWith('/zsm.jpg'), `${res.poster}`);
  const zhFetch = trace.find((s) => s.step === 'search_zh');
  const zhPick = trace.find((s) => s.step === 'search_zh_pick');
  check(
    'trace: 走了中文搜索且挑中 275297',
    !!zhFetch && zhPick?.tmdbId === 275297,
    JSON.stringify(trace.map((s) => s.step))
  );
  check(
    '英文搜索轮没轮到（未请求 Let\'s Go 的 /search/tv）',
    !calledUrls.some((u) => u.includes('/3/search/tv') && u.includes('Let%27s'))
  );
  check(
    '假 id 11932 的 detail 从未被调',
    !calledUrls.some((u) => u.includes('/tv/11932'))
  );
}

// ---- 用例 B：中文搜索返回空 → 年份护栏否决英文候选，title 走 aka ----
{
  console.log('\n用例 B：中文搜索落空，护栏否决 + aka 兜底');
  cnResults = [];
  calledUrls = [];
  const trace = [];
  const res = await computeShowName(mkEnv(), SHOW_CN, true, trace);
  check('tmdbId 为空', res.tmdbId === null, `tmdbId=${res.tmdbId}`);
  check(
    "title 走 aka = 走马上任、via='aka'",
    res.title === '走马上任' && res.via === 'aka',
    `title=${res.title} via=${res.via}`
  );
  const rej = trace.find((s) => s.step === 'search_reject');
  check(
    'trace: 年份护栏否决（year_mismatch，来自英文轮）',
    rej?.reason === 'year_mismatch' && rej?.tmdbId === 11932 && rej?.source === 'search',
    JSON.stringify(rej ?? null)
  );
  const enPick = trace.find((s) => s.step === 'search_pick');
  check('trace: search_pick 视同没挑中（null）', !!enPick && enPick.tmdbId === null);
  check(
    'trace: 先走了中文搜索（落空）',
    !!trace.find((s) => s.step === 'search_zh') &&
      trace.find((s) => s.step === 'search_zh_pick')?.tmdbId === null
  );
  check(
    '假 id 11932 的 detail 从未被调',
    !calledUrls.some((u) => u.includes('/tv/11932'))
  );
  check('不标 transient（全程有结论）', res.transient === false);
}

// ---- 用例 C：英文候选年份相符、无 aka（非国产）→ 维持现行采纳 ----
{
  console.log('\n用例 C：年份相符的英文候选照常采纳');
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.startsWith('https://api.themoviedb.org/')) {
      const parsed = new URL(u);
      if (parsed.pathname === '/3/search/tv') {
        return Promise.resolve(
          jsonResp({
            results: [
              {
                id: 888001,
                name: 'Harbor Lights',
                original_name: 'Harbor Lights',
                first_air_date: '2025-02-20',
              },
            ],
          })
        );
      }
      if (parsed.pathname === '/3/tv/888001') {
        return Promise.resolve(
          jsonResp({
            name: 'Harbor Lights',
            poster_path: '/hl.jpg',
            overview: 'An English-only drama.',
          })
        );
      }
      return Promise.reject(new Error(`unexpected TMDB url: ${u}`));
    }
    return Promise.reject(new Error(`unexpected fetch in case C: ${u}`));
  };
  const trace = [];
  const res = await computeShowName(mkEnv(), SHOW_US, false, trace);
  check('tmdbId 照常采纳 888001', res.tmdbId === 888001, `tmdbId=${res.tmdbId}`);
  check(
    '海报照常带回',
    typeof res.poster === 'string' && res.poster.endsWith('/hl.jpg'),
    `${res.poster}`
  );
  check(
    'detail 名无中文 → title 保持原名、via 不变',
    res.title === 'Harbor Lights' && res.via === 'none',
    `title=${res.title} via=${res.via}`
  );
  check(
    'trace: 无 search_reject、无中文搜索步',
    !trace.some((s) => s.step === 'search_reject') &&
      !trace.some((s) => s.step === 'search_zh') &&
      !trace.some((s) => s.step === 'search_zh_pick') &&
      !trace.some((s) => s.step === 'aka'),
    JSON.stringify(trace.map((s) => s.step))
  );
}

// ---- 用例 D：94262 形状（多别名，TMDB 条目名是第三个别名）----
const SHOW_D = {
  id: 94262,
  name: 'The Confession Truth',
  premiered: '2026-11-07',
  externals: { tvrage: null, thetvdb: null, imdb: null },
  network: null,
  webChannel: { name: 'iQIYI', country: { code: 'CN', name: 'China' } },
};
const ENTRY_D = {
  id: 276001,
  name: '自首真相',
  original_name: '自首真相',
  first_air_date: '2026-11-07',
};

// dSearchMap 按子场景切换每个查询词的返回；英文查询词恒返回正条目
//（模拟现行实测：英文搜索其实返回了这条，但 zh 名与英文串既不全等
// 也不互含、按英文挑人规则不可采纳——本流程里中文轮先命中，英文
// 轮根本不会跑到）。
let dSearchMap = {};
globalThis.fetch = (url) => {
  const u = String(url);
  if (u.startsWith('https://api.themoviedb.org/')) {
    const parsed = new URL(u);
    if (parsed.pathname === '/3/search/tv') {
      const q = parsed.searchParams.get('query');
      return Promise.resolve(jsonResp({ results: dSearchMap[q] ?? [] }));
    }
    if (parsed.pathname === '/3/tv/276001') {
      return Promise.resolve(
        jsonResp({
          name: '自首真相',
          poster_path: '/zsz.jpg',
          overview: '一桩命案背后的三重真相。',
        })
      );
    }
    return Promise.reject(new Error(`unexpected TMDB url: ${u}`));
  }
  if (u === 'https://api.tvmaze.com/shows/94262/akas') {
    return Promise.resolve(
      jsonResp([
        { name: '杀人真相', country: { code: 'CN', name: 'China' } },
        { name: '炬火', country: { code: 'CN', name: 'China' } },
        { name: '自首真相', country: { code: 'CN', name: 'China' } },
      ])
    );
  }
  return Promise.reject(new Error(`unexpected fetch: ${u}`));
};

// ---- D1：搜「杀人真相」回的候选名是「自首真相」，靠别名集采纳 ----
{
  console.log('\n用例 D1：候选名≠查询词，别名集判据采纳');
  dSearchMap = {
    'The Confession Truth': [ENTRY_D],
    '杀人真相': [ENTRY_D],
    '炬火': [],
    '自首真相': [ENTRY_D],
  };
  const trace = [];
  const res = await computeShowName(mkEnv(), SHOW_D, true, trace);
  check('tmdbId = 正条目 276001', res.tmdbId === 276001, `tmdbId=${res.tmdbId}`);
  check(
    "title = 自首真相（detail 中文名）、via='tmdb'",
    res.title === '自首真相' && res.via === 'tmdb',
    `title=${res.title} via=${res.via}`
  );
  const zp = trace.find((s) => s.step === 'search_zh_pick');
  check(
    "trace: search_zh_pick 记命中查询词=杀人真相、候选名=自首真相",
    zp?.tmdbId === 276001 && zp?.query === '杀人真相' && zp?.name === '自首真相',
    JSON.stringify(zp ?? null)
  );
}

// ---- D2：前两词落空、第三词「自首真相」才命中（逐个搜）----
{
  console.log('\n用例 D2：逐个搜到第三个别名才命中');
  dSearchMap = {
    'The Confession Truth': [ENTRY_D],
    '杀人真相': [],
    '炬火': [],
    '自首真相': [ENTRY_D],
  };
  const trace = [];
  const res = await computeShowName(mkEnv(), SHOW_D, true, trace);
  check('tmdbId = 正条目 276001', res.tmdbId === 276001, `tmdbId=${res.tmdbId}`);
  check('title = 自首真相', res.title === '自首真相', `title=${res.title}`);
  const zp = trace.find((s) => s.step === 'search_zh_pick');
  const zhFetches = trace.filter((s) => s.step === 'search_zh');
  check(
    'trace: 中文搜索共试了 3 个别名、命中查询词=自首真相',
    zhFetches.length === 3 && zp?.query === '自首真相',
    `fetches=${zhFetches.length} query=${zp?.query}`
  );
}

// ---- 用例 E：94262 真身形状——country=null、靠 language 判 isCn ----
const SHOW_E = {
  id: 94262,
  name: 'The Confession Truth',
  premiered: '2026-11-07',
  language: 'Chinese',
  externals: { tvrage: null, thetvdb: null, imdb: null },
  network: null,
  webChannel: { name: 'iQIYI', country: null },
};
{
  console.log('\n用例 E：webChannel.country=null，language 补判 isCn');
  check(
    'isChineseShow(language=Chinese) = true（不在 cnShowIds、无国家信号）',
    isChineseShow(SHOW_E, new Set()) === true
  );
  check(
    '对照：language=English 同形状 = false（真值确实来自 language）',
    isChineseShow({ ...SHOW_E, language: 'English' }, new Set()) === false
  );
  dSearchMap = {
    'The Confession Truth': [ENTRY_D],
    '杀人真相': [ENTRY_D],
    '炬火': [],
    '自首真相': [ENTRY_D],
  };
  const trace = [];
  const isCn = isChineseShow(SHOW_E, new Set());
  const res = await computeShowName(mkEnv(), SHOW_E, isCn, trace);
  check('tmdbId = 正条目 276001', res.tmdbId === 276001, `tmdbId=${res.tmdbId}`);
  check(
    "title = 自首真相、via='tmdb'（aka+中文搜索链已跑通）",
    res.title === '自首真相' && res.via === 'tmdb',
    `title=${res.title} via=${res.via}`
  );
  check(
    'trace: 有中文搜索步（漏判时整条链缺席）',
    trace.some((s) => s.step === 'search_zh_pick'),
    JSON.stringify(trace.map((s) => s.step))
  );
}

console.log(failures === 0 ? '\n== ALL PASS ==' : `\n== ${failures} FAILURES ==`);
process.exit(failures === 0 ? 0 : 1);
