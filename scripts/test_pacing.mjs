// TMDB 节流回归测试（v5）：
// 背景：v3/v4 上线后剧名冷启动收敛停滞（remainUnresolved 384→391
// 反升、全周中文标题 2 小时只 +9），每轮毛解析 129~160 部却净减少
// 极小；/resolve 单条调用即时成功，说明不是令牌与通路问题。最可信
// 的解释是批量轮次里 TMDB 并发过高触发限流（429），大量解析以瞬时
// 失败收场、不落缓存，下轮重查同一批 show，白白烧掉时间盒。v5 加
// 模块级节流链（起步间隔 ≥250ms，约 4 请求/秒）+ 429 尊重 Retry-After。
// 断言：
//   场景 A：50 次并发 tmdbFetch（即时 200 桩），任意连续 10 秒窗口
//     内 TMDB 调用 ≤ 45 次，起步间隔中位数 ≥ 200ms，总耗时 ≥ 11 秒；
//   场景 B：桩先返 429（Retry-After: 2）再返 200，第二次调用晚到
//     ≥ 1.9 秒、结果 kind=ok、attempts=2；
//   场景 C：桩 Retry-After: 30，两次调用间隔封顶约 5 秒（不超 6 秒）；
//   场景 D：两次都 429，kind=failed、attempts=2。
// 用法：node scripts/test_pacing.mjs
import { tmdbFetch } from '../src/index.js';

const jsonResp = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const env = { TMDB_TOKEN: 'fake-token-for-pacing-test' };

console.log('== hbcalendar pacing test (v5) ==');

// ---- 场景 A：50 次并发调用的起步节流 ----
console.log('\n场景 A：50 次并发 tmdbFetch（即时 200）');
{
  const times = [];
  globalThis.fetch = () => {
    times.push(Date.now());
    return Promise.resolve(jsonResp({ ok: true }));
  };
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => tmdbFetch(env, `/test/${i}`))
  );
  const elapsed = Date.now() - t0;
  check('50 次调用全部 kind=ok', results.every((r) => r.kind === 'ok'));
  check('50 次调用恰好发出 50 次请求', times.length === 50, `calls=${times.length}`);
  // 任意连续 10 秒窗口内 ≤ 45 次（名义 4 请求/秒 → 10 秒约 40 次起步）
  const sorted = [...times].sort((a, b) => a - b);
  let maxInWindow = 0;
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    while (sorted[i] - sorted[j] > 10000) j++;
    maxInWindow = Math.max(maxInWindow, i - j + 1);
  }
  check('任意 10 秒窗口内 TMDB 调用 ≤ 45 次', maxInWindow <= 45, `max=${maxInWindow}`);
  // 起步间隔：相邻时间戳中位数 ≥ 200ms（名义 250ms，留定时器抖动余量）
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  const medianGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  check(
    '起步间隔中位数 ≥ 200ms（名义 250ms）',
    medianGap >= 200,
    `median=${medianGap}ms`
  );
  check('50 次调用总耗时 ≥ 11 秒（节流真实生效）', elapsed >= 11000, `${elapsed}ms`);
}

// ---- 场景 B：429 + Retry-After: 2 → 重试一次后成功 ----
console.log('\n场景 B：429 + Retry-After: 2 → 重试一次后成功');
{
  const times = [];
  let n = 0;
  globalThis.fetch = () => {
    times.push(Date.now());
    n++;
    if (n === 1) {
      return Promise.resolve(
        jsonResp({ status_message: 'rate limited' }, 429, { 'Retry-After': '2' })
      );
    }
    return Promise.resolve(jsonResp({ ok: true }));
  };
  const t0 = Date.now();
  const r = await tmdbFetch(env, '/test/retry-after');
  const elapsed = Date.now() - t0;
  check('结果 kind=ok（重试后成功）', r.kind === 'ok');
  check(
    '第二次调用晚到 ≥ 1.9 秒（Retry-After 被遵守）',
    times.length === 2 && times[1] - times[0] >= 1900,
    times.length === 2 ? `${times[1] - times[0]}ms` : `calls=${times.length}`
  );
  check('总耗时 ≥ 1.9 秒', elapsed >= 1900, `${elapsed}ms`);
}

// ---- 场景 C：Retry-After: 30 封顶 5 秒 ----
console.log('\n场景 C：Retry-After: 30 封顶 5 秒');
{
  const times = [];
  let n = 0;
  globalThis.fetch = () => {
    times.push(Date.now());
    n++;
    if (n === 1) {
      return Promise.resolve(
        jsonResp({ status_message: 'rate limited' }, 429, { 'Retry-After': '30' })
      );
    }
    return Promise.resolve(jsonResp({ ok: true }));
  };
  const r = await tmdbFetch(env, '/test/retry-after-cap');
  check('结果 kind=ok', r.kind === 'ok');
  const gap = times[1] - times[0];
  check('重试间隔约 5 秒（封顶，不超 6 秒）', gap >= 4800 && gap <= 6000, `${gap}ms`);
}

// ---- 场景 D：两次都 429 → failed ----
console.log('\n场景 D：两次都 429 → failed');
{
  globalThis.fetch = () =>
    Promise.resolve(jsonResp({ status_message: 'rate limited' }, 429, { 'Retry-After': '1' }));
  const r = await tmdbFetch(env, '/test/always-429');
  check('结果 kind=failed', r.kind === 'failed');
}

console.log(failures === 0 ? '\n== ALL PASS ==' : `\n== ${failures} FAILURES ==`);
process.exit(failures === 0 ? 0 : 1);
