// hbcalendar — HBPlayer 追剧日历预聚合服务（Cloudflare Worker）
//
// 职责（v1 只干日历「全局轨」，在追个人轨不进后端、仍由 App 本地合并）：
// - Cron 每 30 分钟（或 POST /refresh 手动）跑一轮聚合：
//   拉 TVmaze 四份排期（web + CN/US/JP，未来 7 天逐日）+ Bangumi 动画周表，
//   在服务端把 TMDB 中文名 / 海报 / 简介一次拼齐，生成逐日成品快照存 KV。
// - 客户端 GET /calendar?date=YYYY-MM-DD 一天一个请求拿成品。
// 合并与补名口径与 App 现行客户端逻辑（calendar_service.dart）逐项对齐，
// 本服务上线后客户端直拉逻辑降为回落。
//
// v2（检查点 + 时间盒）：v1 是全有全无——约 600 部 show 全部补完名才写
// 第一份快照，Cloudflare 上冷缓存一轮要跑几分钟、被平台终止后缓存永远
// 暖不起来（首轮 /refresh 曾挂 5 分钟零产出）。v2 改为：单轮约 50 秒
// 时间盒，排期就绪先写一版快照、补名每满约 60 部再写一版、结束写最终版；
// 超时未解析的 show 不写缓存、留给下一轮 cron 接着解析，名字逐轮补齐。
//
// v3（失败不冻结，2026-11-10）：v2 上线后抽查发现 TVmaze 90035
// 《The Remarried Empress》（externals 齐全、TMDB 有中文条目「再婚皇后」）
// 没解析出 TMDB id，且失败结果被当负缓存冻了 7 天——冷启动风暴里的
// 偶发 429/超时/5xx 与「确实查无此名」在旧代码里都塌缩成 null、无从
// 分辨。v3 把 TMDB 结果分型（ok / notfound 有结论 / failed 瞬时失败）：
// 任一步 failed 且最终没拿到中文名 → 结果标 transient、不落盘，下轮
// cron 自动重试；只有全程有结论才落负缓存。缓存键前缀同时由 showname:
// 换代为 showname2:，把风暴期已冻住的可疑负缓存整体作废（正结果会随
// 后续轮次自动重建）。另加诊断端点 GET /resolve?tvmaze=<id> 实时看轨迹。
//
// v4（集级中文下沉服务端）：剧级中文名之外，集名与集简介的中文也搬到
// 服务端——聚合在剧名解析后新增「集解析」阶段：对已解析出 tmdbId 的
// 集逐个查 TMDB 集详情（zh-CN），查到中文的字段才覆盖快照条目的
// episodeTitle / overview（逐字段独立判定），客户端详情页与集列表读的
// 正是这两个字段，零改动即受益，不再吃用户本地网络抖动。结论按
// ep:{tmdbId}:{季}:{集} 缓存：有中文 30 天、无中文（有结论）7 天、
// 瞬时失败不落盘下轮重试——与 v3 剧名分型同一套口径。
//
// v5（TMDB 节流，2026-11-10）：v3/v4 上线后剧名冷启动收敛在最后一
// 小时停滞——remainUnresolved 384→391 反升、全周中文标题 2 小时只
// +9；每轮毛解析 129~160 部却净减少极小，而 /resolve 单条调用即时
// 成功（find 200 一次命中），说明不是令牌与通路问题。最可信的解释
// 是批量轮次里 TMDB 并发过高触发限流（429），大量解析以瞬时失败收
// 场、不落缓存，下轮重查同一批 show，白白烧掉时间盒。v5：①模块级
// 节流链，所有 tmdbFetch 起步间隔 ≥250ms（约 4 请求/秒）；②并发池
// 剧名/集解析 6→3；③429 尊重 Retry-After（秒，封顶 5 秒）再重试一
// 次；④stats 新增 tmdbOkThisRun / tmdbFailedThisRun，下次验收直接
// 读失败率；⑤补名到点就停落到 show 内：computeShowName 每步前先看
// 是否已过时间盒，过了按未完成返回（transient、不落盘），防止串行
// 慢调用把单轮拖过时限（test_timebox 曾因此 112s > 100s）。宁可每轮
// 毛解析数少一点，也要净成功率上去。
//
// v5-diag（诊断补丁，2026-11-10）：v5 部署后连续多轮 cron 在补名阶段
// 初期停滞——开局约 11 秒写出第一版检查点后，meta 几十分钟不再更新，
// 按 50 秒时间盒本应写出的最终版始终不出现；从外部无法区分是 promise
// 冻在某一步、还是被平台掐断。本版只加两样东西，不改任何解析语义：
// ①诊断埋点：aggregate 维护 diag 状态（phase / 补名进度 / 节流链进出
// 计数 / tmdbFetch 进出计数 / 最近步骤与 show id / 三类超时计数），
// 在阶段变化、补名每满 10 部、任一超时发生时刷到 KV 键 meta:diag，
// /health 原样带回——下一轮再卡，/health 就能直接读出它冻在哪一步、
// 冻之前跑了几个；②超时护栏：resp.json() body 读取（10s）、补名链路
// KV get/put（8s）、tmdbPace slot 等待（10s 链活性看门狗，整链零推进
// 才放行）全部加超时赛跑，超时按「该次调用失败/未命中」处理并计数，
// 保证聚合流程总能走到最终版 stats（stats 亦带 paceTimeouts /
// kvTimeouts / jsonTimeouts 三计数与 diagPhase）。红线不变：缓存键与
// TTL、transient 分型、时间盒、节流间隔、并发与检查点节奏、快照
// 字段结构、对外端点行为全不动。
//
// v5-diag2（诊断补丁第二版，2026-11-10，待用户拍板才部署）：
// v5-diag 首轮（19:30）冻点后移到了集阶段开局——diag 停在
// phase=episodes / updatedAt=开局+51.0s（恰在 50s 时间盒边界），
// 补名实际跑了 28 部、paceIn=paceOut=96、fetchStarted=fetchFinished=59、
// 三超时计数全 0，lastStats 仍停第一检查点。事后复盘代码发现：
// 集阶段开局的 KV 预读 `pool(epQueue, 12, kvGet)` 全程没有任何
// diagTouch / 刷盘触发点，也不受时间盒约束——diag 冻在 episodes
// 入口 flush 那一版，无法区分「预读还在跑」与「isolate 已死」。
// 本版只改集阶段与最终收尾，不改解析语义：①预读改走 poolRolling，
// 每完成记 epPreDoneCount、每 10 个刷一版，取新任务加 deadline+60s
// 宽限（KV 读便宜、让已缓存的集名落袋，超限则停、余集留给现查按
// 未完成处理）；②epTodoCount 落盘后立即刷一版；③最终写包 try/catch，
// 失败也写一版最小 meta（partial=true、diagPhase=final-error）并
// 照常返回——再卡，/health 至少能看到预读跑了几个、队列多大、
// 最终写是挂了还是没走到。红线与 v5-diag 相同。
//
// v6（省写改造，2026-11-10）：21:00 Cloudflare 官方通知证实 Workers
// KV 免费套餐每日 put 上限 1000 次已超限、put 持续 429 失败到次日
// 00:00 UTC 重置。旧版每轮写约 150–250 次（每解析一部剧 1 put、
// 每次检查点重写 7 天快照+meta 共 8 put、检查点一轮多次、diag 刷盘
// ≤60），48 轮/天必爆；且 KV 写失败全程静默吞掉，于是表现为「解析
// 了存不进去、最终统计写不出、快照不更新」的假冻结。用户拍板不升
// 级套餐，本版在 diag2 基础上只做省写，解析语义与对外行为全不动：
// ①剧名/集缓存整表化：废弃 showname2:{id} 与 ep:{...} 逐条键
// （旧键不删、自然过期，新代码不再读写），改为单键整表 names:v1 /
// eps:v1——开局各 1 次 get 读入内存，结论只标 dirty，补名后检查点
// 与收尾各至多 1 次 put 落盘；过期靠条目自带 exp 字段（口径与原 KV
// TTL 一致：剧名正负结论均 7 天、集正结果 30 天/负结果 7 天），
// transient 照旧不入表；②检查点收敛：buildAndWriteDays 每轮至多
// 3 次（开局 / 补名后 / 最终），集阶段不再单独写检查点；③快照跳
// 写：day:{date} 写入前先读现值比对 entries 本体（generatedAt 不
// 参与），相同则跳过 put——配合集缓存在开局检查点前就从整表回填，
// 稳态轮三版快照内容一致、day put 全免；④diag 刷盘再砍：最小间隔
// 10 秒（phase=final 与超时计数增加除外）、里程碑放宽（补名每 25、
// 集每 50）、每轮实际 put 硬顶约 10 次。
// 写预算账（put/轮）：稳态轮 ≈ meta:diag ≤10（实际约 3）+
// meta:lastRefresh 3 + day 0 + names:v1 0 + eps:v1 0 + bangumi ≈0
// → ≤ 约 17；追赶轮（几百部待解析）≈ 稳态基数 + names:v1 ≤2 +
// eps:v1 ≤1 + day 变更日 ≤7×2 → ≤ 约 30。全天 48 轮以稳态为主，
// 合计 ≤ 约 850 次，留余量。
//
// 环境变量 / 绑定（见 wrangler.toml 与 README）：
// - CACHE        KV 绑定：day:YYYY-MM-DD 快照、names:v1 补名整表、
//                eps:v1 集解析整表、meta（lastRefresh / diag）；
//                showname2:{id} 与 ep:{tmdbId}:{s}:{e} 为旧版逐条键，
//                v6 起已弃用（不删、自然过期）
// - TMDB_TOKEN   Worker secret：TMDB 只读访问令牌（未配置则跳过 TMDB 步）
// - REFRESH_KEY  Worker secret：/refresh 的密钥（未配置则禁用该端点）

const TVMAZE = 'https://api.tvmaze.com';
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const NAME_TTL_SEC = 7 * 24 * 3600; // 补名缓存（含负结果）7 天，cron 到期重试
const EP_TTL_POS_SEC = 30 * 24 * 3600; // 集解析正结果（至少一字段中文）30 天
const EP_TTL_NEG_SEC = 7 * 24 * 3600; // 集解析负结果（有结论但无中文）7 天
const RUN_TIMEBOX_MS = 50 * 1000; // 单轮聚合时间盒（v2）：补名到点就停，余量留给下一轮 cron
const EP_PREREAD_GRACE_MS = 60 * 1000; // v5-diag2：集 KV 预读宽限——v6 整表化后预读改为内存查表回填、不再走 KV，此宽限已无适用点，保留备查
// v6 省写（见文件头 v6 段）：整表缓存键 + diag 刷盘节流
const NAMES_TABLE_KEY = 'names:v1'; // 剧名缓存整表：{ [showId]: {title, via, tmdbId, poster, overview, exp} }
const EPS_TABLE_KEY = 'eps:v1'; // 集缓存整表：{ [epKey]: {name, overview, exp} }
const DIAG_FLUSH_MIN_MS = 10 * 1000; // diag 刷盘最小间隔（phase=final / 超时计数增加除外）
const DIAG_PUT_CAP = 9; // diag 每轮实际 put 硬顶（非收尾刷盘；收尾定格另计 1，总计约 10）
const DIAG_MILESTONE_NAMES = 25; // 补名进度刷盘里程碑（每完成 N 部）
const DIAG_MILESTONE_EPS = 50; // 集阶段进度刷盘里程碑（每完成 N 条）
// v5-diag 超时护栏（详见文件头 v5-diag 段）
const JSON_BODY_TIMEOUT_MS = 10 * 1000; // resp.json() body 读取超时
const KV_TIMEOUT_MS = 8 * 1000; // 补名链路 KV get/put 超时
const PACE_WATCHDOG_MS = 10 * 1000; // tmdbPace 链活性看门狗（整链零推进的判定时长）
const UA = 'HBPlayer/1.0 (hbcalendar-worker)';

// ---------------- 小工具 ----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// 超时赛跑（v5-diag）：promise 在 ms 内不结算 → { timeout:true }；
/// 正常结算 → { timeout:false, value }；抛错 → { timeout:false, error }。
/// 永不 reject。语义是「不再等」而非「取消」：底层操作（KV 读写、
/// Response body 读取）会在后台自然走完，调用方按失败/未命中处理。
async function raceTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ timeout: false, value }),
        (error) => ({ timeout: false, error })
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), ms);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

// ---------------- v5-diag 诊断埋点 ----------------
//
// aggregate 开局把本轮 diag 对象挂到模块级 activeDiag；tmdbFetch /
// tmdbPace / KV 包装等底层函数经 diagTouch / diagCount 往里记账。
// 没有聚合在跑时（如 /resolve 单查）全部 no-op，不报错；聚合在跑时
// /resolve 的零星调用会并入当轮计数——诊断口径下可接受。
// 刷盘到 KV 键 meta:diag。v6 再砍刷盘量（见文件头 v6 段）：最小
// 间隔 10 秒（phase=final 与超时计数增加可越间隔）、补名/集进度
// 里程碑放宽到每 25 / 每 50、每轮实际 put 硬顶约 10 次（收尾定格
// 刷盘不占硬顶）。刷盘全程静默，绝不拖垮主流程。

let activeDiag = null;

function diagTouch(patch) {
  if (activeDiag) Object.assign(activeDiag, patch);
}

function diagCount(key, by = 1) {
  const d = activeDiag;
  if (!d) return;
  d[key] = (d[key] ?? 0) + by;
  // 任一超时计数增加都是关键证据，越过最小间隔立即触发一次刷盘
  // （仍受每轮 put 硬顶约束，收尾定格会带出最终计数）
  if (key === 'kvTimeouts' || key === 'paceTimeouts' || key === 'jsonTimeouts') {
    diagFlushPoint(true);
  }
}

function diagPhase(phase) {
  if (!activeDiag) return;
  activeDiag.phase = phase;
  // 只有 final / final-error 越过最小间隔立即刷，其余阶段变化走
  // 常规节流（尾随刷盘会带出最新 phase）
  diagFlushPoint(phase === 'final' || phase === 'final-error');
}

/// 请求一次 diag 刷盘。force=true 越过最小间隔；force=false 且距
/// 上次实际 put 不足 DIAG_FLUSH_MIN_MS 时，只挂一个尾随刷盘，到点
/// 带出最新状态。实际 put 在 flushDiag 内受每轮硬顶约束。
function diagFlushPoint(force = false) {
  const d = activeDiag;
  if (!d || d._sealed) return;
  d.flushes = (d.flushes ?? 0) + 1;
  if (d._flushing) {
    d._flushPending = true; // 在飞的刷盘收尾时会再安排一版最新状态
    return;
  }
  if (!force && Date.now() - (d._lastPutAt ?? 0) < DIAG_FLUSH_MIN_MS) {
    if (!d._trailTimer) {
      const wait = Math.max(
        50,
        DIAG_FLUSH_MIN_MS - (Date.now() - (d._lastPutAt ?? 0))
      );
      d._trailTimer = setTimeout(() => {
        d._trailTimer = null;
        void flushDiag();
      }, wait);
    }
    return;
  }
  void flushDiag();
}

async function flushDiag(target) {
  const d = target ?? activeDiag;
  if (!d?.env || d._sealed) return;
  if (d._flushing) {
    d._flushPending = true;
    return;
  }
  // 硬顶：非收尾刷盘每轮实际 put 至多 DIAG_PUT_CAP 次（收尾定格
  // 刷盘置 _finalFlush 后调用，不占硬顶）
  if (!d._finalFlush && (d._puts ?? 0) >= DIAG_PUT_CAP) return;
  d._flushing = true;
  try {
    d._flushPending = false;
    d.updatedAt = Date.now();
    const snap = {};
    for (const [k, v] of Object.entries(d)) {
      if (k === 'env' || k.startsWith('_')) continue; // 内部字段不落盘
      snap[k] = v;
    }
    // 直连 KV（不走 kvPut，避免刷盘自己再触发计数/刷盘递归）；
    // 同样套超时赛跑，KV 真挂死时刷盘也不能跟着挂死。
    await raceTimeout(
      d.env.CACHE.put('meta:diag', JSON.stringify(snap)),
      KV_TIMEOUT_MS
    );
    d._puts = (d._puts ?? 0) + 1;
    d._lastPutAt = Date.now();
    if (d._flushPending && !d._finalFlush) {
      // 刷盘期间又有新状态：按最小间隔挂尾随刷盘（收尾定格在
      // aggregate 末尾单独强制做，不走这里）
      d._flushPending = false;
      if (!d._trailTimer) {
        d._trailTimer = setTimeout(() => {
          d._trailTimer = null;
          void flushDiag();
        }, DIAG_FLUSH_MIN_MS);
      }
    }
  } catch {
    // 刷盘失败静默
  } finally {
    d._flushing = false;
  }
}

/// 补名链路 KV 读（v5-diag）：8 秒超时赛跑。超时计 kvTimeouts 并按
/// 未命中返回 null；底层抛错同样按未命中（与既有 try/catch 口径一致）。
async function kvGet(env, key) {
  const r = await raceTimeout(
    Promise.resolve().then(() => env.CACHE.get(key, { type: 'json' })),
    KV_TIMEOUT_MS
  );
  if (r.timeout) {
    diagCount('kvTimeouts');
    return null;
  }
  return r.error ? null : r.value ?? null;
}

/// 补名链路 KV 写（v5-diag）：8 秒超时赛跑。超时计 kvTimeouts 并静默
/// 放弃；抛错同样静默（与既有「写失败不影响本轮」口径一致）。
async function kvPut(env, key, value, opts) {
  const r = await raceTimeout(
    Promise.resolve().then(() => env.CACHE.put(key, value, opts)),
    KV_TIMEOUT_MS
  );
  if (r.timeout) {
    diagCount('kvTimeouts');
    return false;
  }
  return !r.error;
}

// ---------------- v6 整表缓存（names:v1 / eps:v1） ----------------
//
// 旧版逐条键（showname2:{id} / ep:{...}）每解析一条就 1 次 put，
// 是 KV 每日写配额爆掉的主因。v6 改为单键整表：开局 1 次 get 读入
// 内存 Map，本轮所有命中/新结论都只在内存里走，结论置 dirty，落盘
// 由 aggregate 在固定落盘点整表 put（dirty 才写）。
// 过期不靠 KV TTL（整表一个键没法按条目设 TTL），靠条目自带 exp
// （毫秒时间戳）：读入时已过期的条目按未命中剔除，落盘时再次过滤。
// 表对象：{ map: Map<key, entry>, dirty: boolean }。entry 形状由各
// 业务定义（剧名：{title, via, tmdbId, poster, overview, exp}；
// 集：{name, overview, exp}）。

/// 读整表（1 次 get；读失败 / 无键 / 结构不对一律按空表）
async function loadKvTable(env, key) {
  const raw = await kvGet(env, key);
  const map = new Map();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      if (typeof v.exp === 'number' && v.exp <= now) continue; // 已过期：按未命中
      map.set(k, v);
    }
  }
  return { map, dirty: false };
}

/// 落整表（dirty 才写，1 次 put；写时顺手剔除已过期条目）
async function persistKvTable(env, key, table) {
  if (!table.dirty) return;
  const now = Date.now();
  const obj = {};
  for (const [k, v] of table.map) {
    if (typeof v?.exp === 'number' && v.exp <= now) {
      table.map.delete(k);
      continue;
    }
    obj[k] = v;
  }
  await kvPut(env, key, JSON.stringify(obj));
  table.dirty = false;
}

/// 标题归一化（与 App _norm 一致：小写 + 去空白与常见标点）
function norm(s) {
  return (s ?? '').toLowerCase().replace(/[\s·:：!！?？\-—]/g, '');
}

/// 是否含中文（与 App _hasCjk 一致：CJK 统一表意 4E00–9FFF）
function hasCjk(s) {
  return /[\u4E00-\u9FFF]/.test(s ?? '');
}

/// 剥 HTML 标签并收拾空白/实体（与 App 的 summary 入库口径一致）
function stripHtml(s) {
  if (!s) return null;
  const t = String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

/// 未来 7 天的日期串（Asia/Shanghai 口径，与用户本地日期一致）
function next7Days() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = fmt.format(new Date()); // YYYY-MM-DD
  const base = new Date(`${today}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/// 简单字符串哈希（ETag 用，FNV-1a）
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/// 带超时的 JSON 拉取；失败/非 2xx 返回 null。
/// v5-diag：resp.json() 的 body 读取再套一层 10 秒超时赛跑——
/// AbortSignal 只管到响应头，body 流若迟迟读不完，原实现会永远等
/// 下去（线上整轮无声冻结的候选挂点之一）；超时按拉取失败返回 null
/// 并计 jsonTimeouts。label 可选：给 diag 记「当前步骤」
/// （schedule / aka / bangumi / show）。
async function fetchJson(url, { headers = {}, timeoutMs = 20000, label } = {}) {
  if (label) diagTouch({ lastLabel: label });
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const jr = await raceTimeout(resp.json(), JSON_BODY_TIMEOUT_MS);
    if (jr.timeout) {
      diagCount('jsonTimeouts');
      return null;
    }
    return jr.error ? null : jr.value;
  } catch {
    return null;
  }
}

/// 分批限并发（批大小与 App 一致：6）
async function pool(items, size, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const res = await Promise.all(batch.map((it, j) => fn(it, i + j)));
    for (let j = 0; j < res.length; j++) out[i + j] = res[j];
  }
  return out;
}

/// 滚动并发池（v2 补名专用）：恒定 size 个 worker 从共享游标取活，
/// 一个慢任务不会像分批 pool 那样拖住整批；shouldStop() 为真时不再取
/// 新任务（在飞的跑完为止），未取的任务留给调用方按「未完成」处理。
/// onDone(已完成数) 在每个任务完成后同步回调（补名用它触发中途检查点）。
/// 返回 { results, completed }，未取的任务 results 为 undefined。
async function poolRolling(items, size, fn, { shouldStop, onDone } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  async function worker() {
    for (;;) {
      if (shouldStop && shouldStop()) return;
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      completed++;
      if (onDone) onDone(completed);
    }
  }
  const n = Math.max(1, Math.min(size, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return { results, completed };
}

// ---------------- TMDB（服务端补名的核心） ----------------

/// v5 节流链（模块级，所有 TMDB 调用共享）：每次 tmdbFetch 发出前
/// 先在链上排队，起步间隔 ≥250ms（约 4 请求/秒，对齐 TMDB 限流量级）。
/// 链用 .catch 兜底不断链；等待发生在 fetch 之前，不计入单次 10 秒超时。
let tmdbPaceChain = Promise.resolve();
let tmdbPaceNextAt = 0;
let tmdbPaceLastSettleAt = Date.now(); // v5-diag：链最近一次 slot 结算时刻
const TMDB_PACE_DEFAULT_MS = 250; // 缺省节流间隔（Worker 版口径，约 4 请求/秒）
let TMDB_PACE_MS = TMDB_PACE_DEFAULT_MS; // aggregate 开局可按 env.TMDB_PACE_MS 覆盖（自托管版放宽）；无覆盖时恒为缺省值、行为不变
function tmdbPace() {
  const slot = tmdbPaceChain.then(async () => {
    const wait = tmdbPaceNextAt - Date.now();
    if (wait > 0) await sleep(wait);
    tmdbPaceNextAt = Math.max(Date.now(), tmdbPaceNextAt) + TMDB_PACE_MS;
    tmdbPaceLastSettleAt = Date.now();
  });
  tmdbPaceChain = slot.catch(() => {});
  // v5-diag 链活性看门狗：不是给等待封顶（合法排队可以远超 10 秒——
  // test_pacing 里 50 次并发排队就要约 12 秒），而是查「链是否还
  // 活着」：每等 10 秒看一眼，slot 已结算就返回；整链在过去 10 秒内
  // 有 slot 结算过（在正常推进）就继续等；整链 10 秒零推进才判定
  // 挂死，计 paceTimeouts 并放行本次调用。链本身不断，后续调用照常
  // 排队；slot 迟到结算的结果被丢弃即可。原实现 slot 若抛错会把
  // tmdbFetch 的 await 打成异常，本版一并吞掉——节流只是限速，
  // 不该成为失败源。
  return (async () => {
    for (;;) {
      const r = await raceTimeout(slot, PACE_WATCHDOG_MS);
      if (!r.timeout) return; // 正常结算（抛错也算，原链有 catch 兜底）
      if (Date.now() - tmdbPaceLastSettleAt < PACE_WATCHDOG_MS) continue;
      diagCount('paceTimeouts');
      return;
    }
  })();
}

/// 解析 Retry-After 头（秒数或 HTTP 日期），返回毫秒、封顶 5 秒；
/// 解析不到返回 null（调用方回落 800ms 退避）
function parseRetryAfter(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Math.min(5, Math.max(0, Number(s))) * 1000;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.min(5000, Math.max(0, t - Date.now()));
  return null;
}

/// TMDB 请求（v3 分型 + v5 节流）：失败只重试 1 次、单次超时 10s。
/// 重试瘦身的理由：cron 每 30 分钟就是现成的重试机制，轮内死等只烧
/// 调用预算、还会把整轮拖过平台时限；这一轮查不到的 show 留给下一轮。
/// v5：①每次发出前先过 tmdbPace 节流链（起步间隔 ≥250ms）；②429
/// 时读 Retry-After（秒，封顶 5 秒）再重试一次，其他 5xx/超时仍
/// 800ms 退避一次。
/// 返回值分三型，调用方据此决定结果能不能当「结论」落负缓存：
/// - { kind:'ok', data }  2xx，data 为解析后的 JSON；
/// - { kind:'notfound' }  有 HTTP 响应且非 429/5xx（404 与其他 4xx）——
///   服务端给了确定答复，属「有结论」，不重试；
/// - { kind:'failed' }    429/5xx/网络异常/超时且重试耗尽——瞬时失败，
///   不是结论，上层不得据此落负缓存（v2 前这两种都塌缩成 null，曾把
///   冷启动风暴里的偶发失败当负结果冻结 7 天）。
/// trace 可选（/resolve 诊断用）：每步追加 { step, path, status, attempts, kind }。
/// tmdbStats 可选（聚合统计用）：{ ok, failed }，终态后按 kind 累加一次。
export async function tmdbFetch(env, path, { label, trace, tmdbStats } = {}) {
  diagCount('fetchStarted');
  diagTouch({ lastLabel: label ?? 'tmdb' });
  let status = null;
  let attempts = 0;
  let outcome = { kind: 'failed' };
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    diagCount('paceIn');
    await tmdbPace(); // v5：所有 TMDB 调用起步节流（v5-diag：带链活性看门狗）
    diagCount('paceOut');
    let backoffMs = 800;
    try {
      const resp = await fetch(`${TMDB_API}${path}`, {
        headers: {
          Authorization: `Bearer ${env.TMDB_TOKEN}`,
          Accept: 'application/json',
          'User-Agent': UA,
        },
        signal: AbortSignal.timeout(10000),
      });
      status = resp.status;
      if (resp.ok) {
        // v5-diag：body 读取套 10 秒超时赛跑（理由同 fetchJson）；
        // 超时/读错按该次请求失败处理——不进 429/4xx 分支，走既有
        // 重试与 failed 分型（status 记 null，与网络失败同口径）。
        const jr = await raceTimeout(resp.json(), JSON_BODY_TIMEOUT_MS);
        if (jr.timeout) diagCount('jsonTimeouts');
        if (jr.timeout || jr.error) {
          status = null;
        } else {
          outcome = { kind: 'ok', data: jr.value };
          break;
        }
      } else if (resp.status === 429) {
        // v5：尊重 Retry-After（秒，封顶 5 秒），再重试一次
        backoffMs = parseRetryAfter(resp.headers.get('Retry-After')) ?? 800;
      } else if (resp.status < 500) {
        outcome = { kind: 'notfound' };
        break;
      }
      // 429 / 5xx / body 读失败 → 走一次重试，仍不行即 failed
    } catch {
      status = null; // 网络抖动 / 超时 / 响应体解析失败 → 走一次重试
    }
    if (attempt === 0) await sleep(backoffMs);
  }
  if (trace) {
    trace.push({ step: label ?? 'tmdb', path, status, attempts, kind: outcome.kind });
  }
  if (tmdbStats) {
    if (outcome.kind === 'ok') tmdbStats.ok++;
    else if (outcome.kind === 'failed') tmdbStats.failed++;
  }
  diagCount('fetchFinished');
  return outcome;
}

/// 标题搜索兜底的命中判定（口径与 App ui23 一致）：
/// 归一化全等（name / original_name）优先；无全等只认首条，
/// 且首条与原名归一化后互含（短串 <3 不作数，防泛匹配）
function pickSearchResult(results, queryTitle) {
  const q = norm(queryTitle);
  if (!q || !Array.isArray(results) || results.length === 0) return null;
  for (const r of results) {
    if (norm(r?.name) === q || norm(r?.original_name) === q) return r;
  }
  const first = results[0];
  for (const cand of [first?.name, first?.original_name]) {
    const n = norm(cand);
    if (n.length >= 3 && q.length >= 3 && (q.includes(n) || n.includes(q))) {
      return first;
    }
  }
  return null;
}

/// 单个 show 的中文名解析：
/// 1) TMDB externals 精确换 id → detail（zh-CN）：name 含 CJK 才采用；
///    find 落空再标题搜索兜底。只要 TMDB id 定下来，海报/zh 简介一并带回。
/// 2) TMDB 没给出中文名且是国产 show → TVmaze akas（CN 优先含 CJK 第一个）。
/// 3) 都没有 → 保留 TVmaze 原名。
/// v3 瞬时标记：TMDB 任一步 failed 且最终标题仍无中文 → transient=true，
/// 调用方（resolveShow）据此不落盘——本轮内存里照常用这个结果（原名/aka
/// 名顶着），下轮 cron 重新解析；只有全程有结论的结果才落盘（正结果与
/// 负结果都落，负结果 TTL 7 天）。trace 可选（/resolve 诊断用）。
export async function computeShowName(env, show, isCn, trace, runCtx) {
  const tmdbStats = runCtx?.tmdbStats;
  const base = {
    title: show.name,
    via: 'none', // 'tmdb' | 'aka' | 'none'
    tmdbId: null,
    poster: null, // TMDB 海报 URL（有才有）
    overview: null, // TMDB show 级 zh 简介（有才有）
    transient: false, // v3：true = 本轮 TMDB 有瞬时失败且没拿到中文名，不落盘
  };
  // v5：时间盒内到点即停——聚合的 50 秒时间盒只拦「取新任务」，一个
  // show 内的 find→search→detail 是串行的，慢调用会把单轮拖过时限
  // （test_timebox 曾因此 112s > 100s）。每步之前先看是否已过时间盒，
  // 过了就按未完成返回（transient，除非标题本身已有中文），不落盘、
  // 下轮 cron 重新解析。runCtx 未传（如 /resolve 诊断）时不设限。
  const pastDeadline = () =>
    runCtx?.deadlineMs != null && Date.now() > runCtx.deadlineMs;
  const bail = () => {
    base.transient = !hasCjk(base.title);
    return base;
  };

  if (env.TMDB_TOKEN) {
    const ext = show.externals ?? {};
    let tmdbFailed = false;
    let tmdbId = null;
    if (pastDeadline()) return bail();
    if (ext.imdb) {
      const f = await tmdbFetch(
        env,
        `/find/${encodeURIComponent(ext.imdb)}?external_source=imdb_id`,
        { label: 'find_imdb', trace, tmdbStats }
      );
      if (f.kind === 'failed') tmdbFailed = true;
      else tmdbId = f.data?.tv_results?.[0]?.id ?? null;
    }
    if (tmdbId == null && ext.thetvdb) {
      if (pastDeadline()) return bail();
      const f = await tmdbFetch(
        env,
        `/find/${ext.thetvdb}?external_source=tvdb_id`,
        { label: 'find_tvdb', trace, tmdbStats }
      );
      if (f.kind === 'failed') tmdbFailed = true;
      else tmdbId = f.data?.tv_results?.[0]?.id ?? null;
    }
    if (tmdbId == null) {
      if (pastDeadline()) return bail();
      const s = await tmdbFetch(
        env,
        `/search/tv?query=${encodeURIComponent(show.name)}&language=zh-CN&page=1`,
        { label: 'search', trace, tmdbStats }
      );
      if (s.kind === 'failed') {
        tmdbFailed = true;
      } else {
        const pick = pickSearchResult(s.data?.results ?? [], show.name);
        if (trace) {
          trace.push({
            step: 'search_pick',
            tmdbId: pick?.id ?? null,
            name: pick?.name ?? null,
          });
        }
        if (pick) tmdbId = pick.id;
      }
    }
    if (tmdbId != null) {
      if (pastDeadline()) return bail();
      const d = await tmdbFetch(env, `/tv/${tmdbId}?language=zh-CN`, {
        label: 'detail',
        trace,
        tmdbStats,
      });
      if (d.kind === 'failed') {
        tmdbFailed = true;
      } else if (d.kind === 'ok' && d.data) {
        const detail = d.data;
        base.tmdbId = tmdbId;
        base.poster = detail.poster_path
          ? `${TMDB_IMG}${detail.poster_path}`
          : null;
        base.overview = (detail.overview ?? '').trim() || null;
        if (trace) {
          trace.push({
            step: 'detail_name',
            name: detail.name ?? null,
            hasCjk: !!(detail.name && hasCjk(detail.name)),
          });
        }
        if (detail.name && hasCjk(detail.name)) {
          base.title = detail.name;
          base.via = 'tmdb';
          return base; // 正结果，transient 恒 false
        }
      }
      // detail 为 notfound（id 不存在）属有结论，照常往下走
    }
    base.transient = tmdbFailed;
  } else if (trace) {
    trace.push({ step: 'tmdb', kind: 'skipped', reason: 'TMDB_TOKEN 未配置' });
  }

  if (isCn) {
    if (pastDeadline()) return bail();
    diagTouch({ lastShowId: show.id });
    const aka = await akaName(show.id);
    if (trace) trace.push({ step: 'aka', result: aka });
    if (aka) {
      base.title = aka;
      base.via = 'aka';
    }
  }
  // 拿到中文标题（TMDB/aka/原名自带）即算有结论，失败标记作废；
  // 只有「标题仍无中文且 TMDB 有过瞬时失败」才是 transient。
  if (hasCjk(base.title)) base.transient = false;
  return base;
}

/// TVmaze 别名补名：CN aka 里优先第一个含 CJK 的（吞噬星空拼音在前的教训），
/// 全无 CJK 才回落第一个非空
async function akaName(showId) {
  const list = await fetchJson(`${TVMAZE}/shows/${showId}/akas`, { label: 'aka' });
  if (!Array.isArray(list)) return null;
  let firstAny = null;
  for (const a of list) {
    if (a?.country?.code !== 'CN') continue;
    const n = (a?.name ?? '').trim();
    if (!n) continue;
    if (hasCjk(n)) return n;
    if (firstAny == null) firstAny = n;
  }
  return firstAny;
}

/// 是否国产 show：在 CN 排期出现过，或 network/webChannel 国家为 CN
function isChineseShow(show, cnShowIds) {
  return (
    cnShowIds.has(show.id) ||
    show?.network?.country?.code === 'CN' ||
    show?.webChannel?.country?.code === 'CN'
  );
}

/// 带缓存的 show 名解析（进程内再 memo 一层）。落盘口径（v3 起）：
/// - 正结果与「全程有结论」的负结果 → 入缓存，exp = 现在 + 7 天
///   （负结果到期由 cron 重试，新剧中文资料补齐后能自愈）；
/// - transient 结果（TMDB 有瞬时失败、没拿到中文名）→ 不入缓存，
///   只进进程内 memo 本轮用，下轮 cron 必然重新解析，不再把偶发
///   失败冻结成 7 天的假结论。
/// v6 存储：缓存是 names:v1 整表（内存 Map，由 aggregate 开局读入、
/// 经 runCtx.namesTable 传入），命中直接查表，新结论只标 dirty，
/// 落盘由 aggregate 在补名后检查点与收尾统一整表 put。无聚合上下
/// 文单独调用时（回归测试）自读整表、得出结论后自行落盘。
/// probe 可选：本轮真跑了 computeShowName（非缓存命中）时置
/// probe.computed，供聚合统计 resolvedThisRun。
export async function resolveShow(env, show, isCn, runCache, probe, runCtx) {
  const id = show.id;
  if (runCache.has(id)) return runCache.get(id);
  let table = runCtx?.namesTable ?? null;
  let ownTable = false;
  if (!table) {
    table = await loadKvTable(env, NAMES_TABLE_KEY);
    ownTable = true;
  }
  const hit = table.map.get(String(id));
  let res;
  if (hit && typeof hit.title === 'string') {
    res = {
      title: hit.title,
      via: hit.via ?? 'none',
      tmdbId: hit.tmdbId ?? null,
      poster: hit.poster ?? null,
      overview: hit.overview ?? null,
      transient: false,
    };
  } else {
    if (probe) probe.computed = true;
    res = await computeShowName(env, show, isCn, undefined, runCtx);
    if (!res.transient) {
      table.map.set(String(id), {
        title: res.title,
        via: res.via,
        tmdbId: res.tmdbId ?? null,
        poster: res.poster ?? null,
        overview: res.overview ?? null,
        exp: Date.now() + NAME_TTL_SEC * 1000, // 正负结论同口径 7 天
      });
      table.dirty = true;
      if (ownTable) await persistKvTable(env, NAMES_TABLE_KEY, table);
    }
  }
  runCache.set(id, res);
  return res;
}

// ---------------- 集解析（v4：集名 / 集简介中文下沉） ----------------

/// 集解析条目键（eps:v1 整表内的键）：按 TMDB 剧 id + 季 + 集定位，
/// 与 show 的 TVmaze id 无关
const epKey = (tmdbId, season, episode) => `ep:${tmdbId}:${season}:${episode}`;

/// 单集 TMDB 详情（zh-CN）现查：取 name 与 overview 原样返回（是否采用
/// 由回填处逐字段判 CJK，这里不做取舍）。沿用 v3 分型：kind=failed 是
/// 瞬时失败 → transient=true，调用方不落盘、下轮重试；ok / notfound
/// 都是有结论（notfound 即 TMDB 没这一集，name/overview 记 null）。
async function computeEpisode(env, tmdbId, season, episode, runCtx) {
  const r = await tmdbFetch(
    env,
    `/tv/${tmdbId}/season/${season}/episode/${episode}?language=zh-CN`,
    { label: 'episode', tmdbStats: runCtx?.tmdbStats }
  );
  if (r.kind === 'failed') return { transient: true, name: null, overview: null };
  if (r.kind !== 'ok') return { transient: false, name: null, overview: null };
  return {
    transient: false,
    name: (r.data?.name ?? '').trim() || null,
    overview: (r.data?.overview ?? '').trim() || null,
  };
}

/// 带缓存的单集解析（队列已按 key 去重，本轮内不会重复进到这里）：
/// - 有结论才入缓存：至少一字段含中文 = 正结果，exp 30 天；两字段
///   都无中文（英文原样 / 空 / notfound）= 负结果，exp 7 天；
/// - transient（瞬时失败）不入缓存，本轮内存也不采用（字段保持
///   TVmaze 原值），下轮 cron 重新解析——与 v3 剧名 transient 同口径。
/// v6 存储：eps:v1 整表（经 runCtx.epsTable 传入），新结论只标
/// dirty，收尾由 aggregate 整表落盘；无聚合上下文时自读自落。
async function resolveEpisode(env, item, runCtx) {
  const r = await computeEpisode(env, item.tmdbId, item.season, item.episode, runCtx);
  if (r.transient) return r;
  const positive = hasCjk(r.name ?? '') || hasCjk(r.overview ?? '');
  let table = runCtx?.epsTable ?? null;
  let ownTable = false;
  if (!table) {
    table = await loadKvTable(env, EPS_TABLE_KEY);
    ownTable = true;
  }
  table.map.set(item.key, {
    name: r.name,
    overview: r.overview,
    exp: Date.now() + (positive ? EP_TTL_POS_SEC : EP_TTL_NEG_SEC) * 1000,
  });
  table.dirty = true;
  if (ownTable) await persistKvTable(env, EPS_TABLE_KEY, table);
  return r;
}

// ---------------- 排期与 Bangumi ----------------

const SCHEDULE_PATHS = [
  (d) => `/schedule/web?date=${d}`,
  (d) => `/schedule?date=${d}&country=CN`,
  (d) => `/schedule?date=${d}&country=US`,
  (d) => `/schedule?date=${d}&country=JP`,
];

/// 解析一份排期列表进 out（按集 id 去重，与 App 的 seenEp 口径一致）
function parseScheduleList(list, seenEp, out) {
  if (!Array.isArray(list)) return;
  for (const e of list) {
    const epId = e?.id;
    if (epId == null || seenEp.has(epId)) continue;
    seenEp.add(epId);
    const show = e.show ?? e._embedded?.show;
    if (!show) continue;
    const title = show.name ?? '';
    if (!title) continue;
    let airDate = null;
    if (e.airstamp) airDate = e.airstamp;
    else if (e.airdate) airDate = `${e.airdate}T00:00:00+08:00`;
    if (!airDate) continue;
    const img = show.image ?? {};
    const network = show.network ?? show.webChannel ?? {};
    out.push({
      showTitle: title,
      coverUrl: img.original ?? img.medium ?? null,
      airDate,
      hasTime: !!(e.airtime && String(e.airtime).length > 0),
      season: e.season ?? null,
      episode: e.number ?? null,
      episodeTitle:
        e.name && !String(e.name).startsWith('Episode ') ? e.name : null,
      network: network.name ?? null,
      source: 'tvmaze-schedule',
      popularity: 0,
      overview: stripHtml(e.summary) ?? stripHtml(show.summary),
      _show: show,
    });
  }
}

/// Bangumi 周表：按天 KV 缓存一份（key 带日期），失败不留缓存
async function loadBangumiRaw(env, todayStr) {
  const key = `bangumi:${todayStr}`;
  // v5-diag：读走 kvGet（8s 超时/读错按未命中）
  const hit = await kvGet(env, key);
  if (Array.isArray(hit)) return hit;
  const raw = await fetchJson('https://api.bgm.tv/calendar', {
    headers: { 'User-Agent': 'HBPlayer/1.0' },
    timeoutMs: 15000,
    label: 'bangumi',
  });
  if (Array.isArray(raw)) {
    // v5-diag：写走 kvPut（8s 超时静默放弃，写失败不影响本轮）
    await kvPut(env, key, JSON.stringify(raw), {
      expirationTtl: 24 * 3600,
    });
    return raw;
  }
  return null;
}

/// 某天的 Bangumi 条目（口径与 App 一致：人气门槛 votes/doing ≥50、
/// 与排期标题去重、人气降序每日 ≤40、标题 name_cn 优先）
function bangumiEntriesFor(dateStr, raw, existingTitles) {
  if (!Array.isArray(raw)) return [];
  const jsDay = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sun
  const weekdayId = ((jsDay + 6) % 7) + 1; // 1=Mon..7=Sun，与 Bangumi 一致
  const out = [];
  for (const group of raw) {
    if (group?.weekday?.id !== weekdayId) continue;
    const parsed = [];
    for (const it of group.items ?? []) {
      const votes = it?.rating?.total ?? 0;
      const doing = it?.collection?.doing ?? 0;
      if (votes < 50 && doing < 50) continue;
      const nameCn = it?.name_cn ?? '';
      const name = it?.name ?? '';
      const title = nameCn || name;
      if (!title) continue;
      if (
        existingTitles.has(norm(title)) ||
        (name && existingTitles.has(norm(name)))
      ) {
        continue;
      }
      const images = it?.images ?? {};
      parsed.push({
        showTitle: title,
        coverUrl: images.large ?? images.common ?? null,
        airDate: `${dateStr}T00:00:00+08:00`,
        hasTime: false,
        season: null,
        episode: null,
        episodeTitle: '动画周更',
        network: null,
        source: 'bangumi',
        popularity: votes + doing,
        overview: stripHtml(it?.summary),
      });
    }
    parsed.sort((a, b) => b.popularity - a.popularity);
    out.push(...parsed.slice(0, 40));
  }
  return out;
}

// ---------------- 聚合主流程 ----------------

/// 逐日成快照写 KV 并刷新 meta（v2 检查点函数）：回填当前 nameByShowId
/// 与 epByKey → 合 Bangumi → 排序 → 写 day: 快照与 meta:lastRefresh。
/// v6 起一轮至多调用 3 次：开局检查点（排期就绪先行版）、补名后检查
/// 点、最终版；集阶段不再单独写（进度靠 diag 刷盘报）。
/// run: { startedAt, tmdbConfigured, showsResolved, partial,
/// resolvedThisRun, episodeResolved?, episodeResolvedThisRun?,
/// episodeRemain?, tmdbOkThisRun?, tmdbFailedThisRun?, diag? }；
/// remainUnresolved 由 nameByShowId 的覆盖数推导，集计数与 TMDB
/// 成败计数、超时计数字段缺省为 0（各自阶段之前的检查点）。
/// v5-diag：run.diag 在场时 stats 同步带三类超时计数与当前 diagPhase。
async function buildAndWriteDays(env, days, perDay, bangumiRaw, nameByShowId, epByKey, run) {
  const dayStats = {};
  for (const d of days) {
    const entries = perDay.get(d) ?? [];
    let tmdbNamed = 0;
    let akaNamed = 0;
    const finalEntries = entries.map((e) => {
      const res = e._show?.id != null ? nameByShowId.get(e._show.id) : null;
      const out = { ...e };
      delete out._show;
      if (res) {
        out.showTitle = res.title;
        if (res.poster) out.tmdbCoverUrl = res.poster;
        if (res.overview) out.tmdbOverview = res.overview;
        if (res.via === 'tmdb') tmdbNamed++;
        else if (res.via === 'aka') akaNamed++;
        // 集级中文回填（v4）：逐字段独立判定——某字段查到非空中文才
        // 覆盖，查不到中文的字段保持 TVmaze 原值不动。Bangumi 条目
        // 不走这里（在下面单独合入、本就无 tmdbId），季/集号为空的
        // 条目同样跳过。
        if (
          res.tmdbId != null &&
          e.source === 'tvmaze-schedule' &&
          e.season != null &&
          e.episode != null
        ) {
          const ep = epByKey.get(epKey(res.tmdbId, e.season, e.episode));
          if (ep) {
            if (ep.name && hasCjk(ep.name)) out.episodeTitle = ep.name;
            if (ep.overview && hasCjk(ep.overview)) out.overview = ep.overview;
          }
        }
      }
      return out;
    });
    const existingTitles = new Set(finalEntries.map((e) => norm(e.showTitle)));
    finalEntries.push(...bangumiEntriesFor(d, bangumiRaw, existingTitles));
    finalEntries.sort((a, b) => {
      const t = String(a.airDate).localeCompare(String(b.airDate));
      if (t !== 0) return t;
      return String(a.showTitle).localeCompare(String(b.showTitle));
    });
    const snapshot = {
      date: d,
      generatedAt: new Date().toISOString(),
      counts: {
        entries: finalEntries.length,
        tmdbNamed,
        akaNamed,
      },
      entries: finalEntries,
    };
    dayStats[d] = snapshot.counts;
    // v6 快照跳写：先读现值，只比 entries 本体（generatedAt 不参与
    // 比对）——内容相同就不 put、保留旧快照（含其 generatedAt）。
    // 稳态轮开局/补名后/最终三版内容一致，day put 全免。走 kvGet /
    // kvPut（8s 超时静默，读失败按「无现值」照常写、写失败不中断）。
    const existing = await kvGet(env, `day:${d}`);
    const unchanged =
      existing &&
      typeof existing === 'object' &&
      JSON.stringify(existing.entries) === JSON.stringify(finalEntries);
    if (!unchanged) {
      await kvPut(env, `day:${d}`, JSON.stringify(snapshot));
    }
  }

  const stats = {
    ok: true,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - run.startedAt,
    tmdbConfigured: run.tmdbConfigured,
    showsResolved: run.showsResolved,
    partial: run.partial,
    resolvedThisRun: run.resolvedThisRun,
    remainUnresolved: run.showsResolved - nameByShowId.size,
    episodeResolved: run.episodeResolved ?? 0,
    episodeResolvedThisRun: run.episodeResolvedThisRun ?? 0,
    episodeRemain: run.episodeRemain ?? 0,
    tmdbOkThisRun: run.tmdbOkThisRun ?? 0,
    tmdbFailedThisRun: run.tmdbFailedThisRun ?? 0,
    paceTimeouts: run.diag?.paceTimeouts ?? 0,
    kvTimeouts: run.diag?.kvTimeouts ?? 0,
    jsonTimeouts: run.diag?.jsonTimeouts ?? 0,
    diagPhase: run.diag?.phase ?? null,
    days: dayStats,
  };
  // v5-diag：走 kvPut（8s 超时静默放弃，meta 写失败不影响快照）
  await kvPut(
    env,
    'meta:lastRefresh',
    JSON.stringify({ at: stats.generatedAt, stats })
  );
  return stats;
}

/// 补名前的缓存预热（v6 整表版）：names:v1 整表已在 aggregate 开局
/// 读入内存，这里纯内存查表把已缓存的补名结果填进 nameByShowId /
/// runCache——旧版逐 show 一次 KV get（约 600 次/轮）整段消失。
/// 让检查点 ① 的快照就带上已解析的名字（未命中的留待补名现算）。
function seedNamesFromTable(namesTable, shows, nameByShowId, runCache) {
  for (const show of shows) {
    const e = namesTable.map.get(String(show.id));
    if (e && typeof e.title === 'string') {
      const res = {
        title: e.title,
        via: e.via ?? 'none',
        tmdbId: e.tmdbId ?? null,
        poster: e.poster ?? null,
        overview: e.overview ?? null,
        transient: false,
      };
      runCache.set(show.id, res);
      nameByShowId.set(show.id, res);
    }
  }
}

/// 集队列构建（v4 口径）：从当前条目里收集「有 tmdbId 的真实集」，
/// 按 (tmdbId, 季, 集) 去重（同一集在多天/多份排期出现也只查一次），
/// 按 airDate 先后排序。nameByShowId 在 seed 后与补名后各调一次：
/// 前者供开局检查点前回填，后者是集阶段的正式队列（含本轮新解析
/// 出 tmdbId 的 show，语义与旧版一致）。
function buildEpQueue(days, perDay, nameByShowId) {
  const byKey = new Map();
  for (const d of days) {
    for (const e of perDay.get(d) ?? []) {
      if (e.source !== 'tvmaze-schedule') continue;
      if (e.season == null || e.episode == null) continue;
      const res = e._show?.id != null ? nameByShowId.get(e._show.id) : null;
      if (res?.tmdbId == null) continue;
      const key = epKey(res.tmdbId, e.season, e.episode);
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          tmdbId: res.tmdbId,
          season: e.season,
          episode: e.episode,
          airDate: e.airDate,
        });
      }
    }
  }
  return [...byKey.values()].sort((a, b) =>
    String(a.airDate).localeCompare(String(b.airDate))
  );
}

/// 集缓存回填（v6 整表版）：eps:v1 整表在内存里，队列逐条查表，
/// 命中直接填 epByKey——替代旧版逐条 KV get 的预读池。纯同步循环；
/// onProgress(已处理数) 可选，供 diag 每 50 条刷一次进度。
function fillEpFromTable(epsTable, queue, epByKey, onProgress) {
  let processed = 0;
  for (const item of queue) {
    if (!epByKey.has(item.key)) {
      const e = epsTable.map.get(item.key);
      if (e) {
        epByKey.set(item.key, {
          name: e.name ?? null,
          overview: e.overview ?? null,
        });
      }
    }
    processed++;
    if (onProgress && processed % DIAG_MILESTONE_EPS === 0) {
      onProgress(processed);
    }
  }
  return processed;
}

/// 跑一轮聚合：未来 7 天逐日快照写入 KV（day:YYYY-MM-DD）+ meta 统计。
/// cron 与 /refresh 共用。返回本轮统计对象。
/// v2 起带时间盒与检查点：排期就绪先落一版快照，补名到点未完的留给
/// 下一轮（stats.partial=true、remainUnresolved>0），不再全有全无。
export async function aggregate(env) {
  const startedAt = Date.now();
  // 自托管（Docker）版可经 env.RUN_TIMEBOX_MS 放长单轮时间盒、经
  // env.TMDB_PACE_MS 放宽 TMDB 节流间隔（模块变量，tmdbPace 读取）；
  // Worker 版 env 无这两项 → 一律回落原常量/缺省值，行为一字不变。
  const timeboxMs =
    Number(env.RUN_TIMEBOX_MS) > 0 ? Number(env.RUN_TIMEBOX_MS) : RUN_TIMEBOX_MS;
  TMDB_PACE_MS =
    Number(env.TMDB_PACE_MS) > 0 ? Number(env.TMDB_PACE_MS) : TMDB_PACE_DEFAULT_MS;
  const deadline = startedAt + timeboxMs; // 时间盒：补名最多跑到这
  const days = next7Days();
  const tmdbConfigured = !!env.TMDB_TOKEN;
  // v5：本轮 TMDB 调用成败计数（tmdbFetch 终态累加），检查点与最终
  // meta 都带上，下次验收直接读失败率、不用再推测是否又被限流。
  const tmdbStats = { ok: 0, failed: 0 };
  // v5-diag：本轮诊断状态（字段含义见文件头 v5-diag 段）。挂到模块级
  // activeDiag 供底层函数记账；env 与下划线字段是内部机制、不落盘。
  // 聚合若中途抛错，activeDiag 故意不摘——冻住的那份状态本身就是
  // 验尸材料，下一轮聚合开局会整体覆盖。
  const diag = {
    runId: startedAt,
    runStartedAt: new Date(startedAt).toISOString(),
    phase: 'schedule',
    todoCount: 0,
    doneCount: 0,
    epTodoCount: 0,
    epDoneCount: 0,
    epQueueCount: 0,
    epPreDoneCount: 0,
    epPreStopped: false,
    paceIn: 0,
    paceOut: 0,
    fetchStarted: 0,
    fetchFinished: 0,
    lastLabel: null,
    lastShowId: null,
    lastEpKey: null,
    kvTimeouts: 0,
    paceTimeouts: 0,
    jsonTimeouts: 0,
    flushes: 0,
    updatedAt: startedAt,
    env,
    _flushing: false,
    _flushPending: false,
    _trailTimer: null,
    _puts: 0, // v6：本轮 diag 实际 put 次数（硬顶计数）
    _lastPutAt: 0, // v6：上次 diag 实际 put 时刻（最小间隔判定）
    _finalFlush: false, // v6：收尾定格刷盘标记（不占硬顶）
    _sealed: false, // v6：收尾定格后封盘，不再接受任何刷盘
  };
  activeDiag = diag;
  diagFlushPoint(true); // 开局先刷一版（phase=schedule），证明本轮活着
  // v5：本轮上下文（TMDB 计数 + 时间盒），传给补名/集解析；computeShowName
  // 每步前凭 deadlineMs 判断是否已过时间盒，过时按未完成返回。
  const runCtx = { tmdbStats, deadlineMs: deadline, diag };
  const tmdbRunCounts = () => ({
    tmdbOkThisRun: tmdbStats.ok,
    tmdbFailedThisRun: tmdbStats.failed,
  });

  // 1) 四份排期 × 7 天（限并发 5 拉取）
  const jobs = [];
  for (const d of days) {
    for (let li = 0; li < SCHEDULE_PATHS.length; li++) jobs.push({ d, li });
  }
  const lists = await pool(jobs, 5, async ({ d, li }) =>
    fetchJson(`${TVMAZE}${SCHEDULE_PATHS[li](d)}`, { timeoutMs: 15000, label: 'schedule' })
  );

  // 2) 逐日解析 + 收集 CN show id 与全部 show
  const cnShowIds = new Set();
  const showsById = new Map();
  const perDay = new Map(); // dateStr -> entries(含 _show)
  {
    let k = 0;
    for (const d of days) {
      const seenEp = new Set();
      const entries = [];
      for (let li = 0; li < SCHEDULE_PATHS.length; li++) {
        const list = lists[k++];
        if (li === 1 && Array.isArray(list)) {
          for (const e of list) {
            const show = e?.show ?? e?._embedded?.show;
            if (show?.id != null) cnShowIds.add(show.id);
          }
        }
        parseScheduleList(list, seenEp, entries);
      }
      for (const e of entries) {
        if (e._show?.id != null && !showsById.has(e._show.id)) {
          showsById.set(e._show.id, e._show);
        }
      }
      perDay.set(d, entries);
    }
  }

  // 3) Bangumi 周表（一次拉取，7 天共用；提前到补名之前，检查点 ① 就要合入）
  const bangumiRaw = await loadBangumiRaw(env, days[0]);

  // 4) 检查点 ①：先把整表缓存预热进来，排期 + Bangumi 就绪即写一版
  //    快照与 meta —— /calendar、/health 不必等整轮补名跑完才有东西。
  //    v6：names:v1 / eps:v1 各 1 次 get 读入内存整表；剧名 seed 纯
  //    内存查表；集缓存在这里就按 seed 后的剧名回填 epByKey，让检
  //    查点 ① 的快照带上已缓存的集名——稳态轮三版快照内容因此一
  //    致、day 跳写全免（旧版集 seed 在集阶段才做，检查点与最终版
  //    必然内容不同、每轮来回重写）。
  const runCache = new Map();
  const nameByShowId = new Map();
  const epByKey = new Map(); // v4：集解析结论（整表 seed + 本轮新解析）
  const shows = [...showsById.values()];
  diagPhase('seed');
  const namesTable = await loadKvTable(env, NAMES_TABLE_KEY);
  runCtx.namesTable = namesTable;
  seedNamesFromTable(namesTable, shows, nameByShowId, runCache);
  const epsTable = await loadKvTable(env, EPS_TABLE_KEY);
  runCtx.epsTable = epsTable;
  fillEpFromTable(epsTable, buildEpQueue(days, perDay, nameByShowId), epByKey);
  let resolvedThisRun = 0;
  const runBase = { startedAt, tmdbConfigured, showsResolved: showsById.size, diag };
  diagPhase('checkpoint1');
  await buildAndWriteDays(env, days, perDay, bangumiRaw, nameByShowId, epByKey, {
    ...runBase,
    partial: true,
    resolvedThisRun,
    ...tmdbRunCounts(),
  });

  // 5) 补名：只处理缓存未命中的 show。滚动池恒定 3 在飞（v5：配合
  //    TMDB 节流，慢 show 不拖整批）；过了时间盒就不再取新任务（在飞
  //    的跑完为止），未解析的 show 不入表、留给下一轮。新结论只标
  //    names 表 dirty；阶段结束统一落盘整表 + 写一版检查点（v6：
  //    替代旧版每满 60 部一版检查点，put 从每部 1 次降到整轮 ≤2 次）。
  const todo = shows.filter((s) => !runCache.has(s.id));
  diagTouch({ todoCount: todo.length });
  diagPhase('names');
  const { completed } = await poolRolling(
    todo,
    3,
    async (show) => {
      const probe = {};
      diagTouch({ lastShowId: show.id, lastLabel: 'resolve' });
      try {
        const res = await resolveShow(
          env,
          show,
          isChineseShow(show, cnShowIds),
          runCache,
          probe,
          runCtx
        );
        if (probe.computed) resolvedThisRun++;
        if (res) nameByShowId.set(show.id, res);
        return res;
      } catch {
        return null; // 单个 show 异常按未解析处理，不拖垮整轮，留给下一轮
      }
    },
    {
      shouldStop: () => Date.now() > deadline,
      onDone: (done) => {
        diagTouch({ doneCount: done });
        if (done % DIAG_MILESTONE_NAMES === 0) diagFlushPoint();
      },
    }
  );
  // 补名后检查点（v6 本轮第 2 次 buildAndWriteDays）：先落 names 整
  // 表（dirty 才写），再写一版带新名字的快照（内容没变的日期跳写）。
  await persistKvTable(env, NAMES_TABLE_KEY, namesTable);
  await buildAndWriteDays(env, days, perDay, bangumiRaw, nameByShowId, epByKey, {
    ...runBase,
    partial: true,
    resolvedThisRun,
    ...tmdbRunCounts(),
  });

  // 6) 集解析（v4）：剧名阶段之后、共用同一个时间盒。队列按补名后
  //    的 nameByShowId 重建（本轮新解析出 tmdbId 的 show 一并入队，
  //    语义与旧版一致）；缓存命中已在内存整表里，逐条查表回填即可
  //    （旧版逐条 KV get 的预读池整段消失），未命中的才现查。未配
  //    TMDB 令牌时没有任何 show 能解析出 tmdbId，队列自然为空、
  //    本阶段整体跳过。v6：本阶段不再写检查点（进度靠 diag）。
  const epQueue = buildEpQueue(days, perDay, nameByShowId);
  diagPhase('episodes');
  // v5-diag2 的关切保留：集阶段进度必须可见——整表回填虽是纯内存
  // 操作（毫秒级），仍按每 50 条记 epPreDoneCount 并刷一版，队列
  // 规模先落盘，最终写若挂 /health 也能看到队列多大、回填了多少。
  diagTouch({ epQueueCount: epQueue.length });
  diagFlushPoint();
  const epPreCount = fillEpFromTable(epsTable, epQueue, epByKey, (done) => {
    diagTouch({ epPreDoneCount: done });
    diagFlushPoint();
  });
  diagTouch({ epPreDoneCount: epPreCount, epPreStopped: false });
  diagFlushPoint();
  let episodeResolvedThisRun = 0;
  const epRunStats = () => ({
    episodeResolved: epByKey.size,
    episodeResolvedThisRun,
    episodeRemain: epQueue.length - epByKey.size,
  });
  const epTodo = epQueue.filter((it) => !epByKey.has(it.key));
  diagTouch({ epTodoCount: epTodo.length });
  diagFlushPoint(); // v5-diag2：队列规模先落盘——最终写若挂，/health 至少能看到 epTodoCount
  const epResult = await poolRolling(
    epTodo,
    3,
    async (item) => {
      diagTouch({ lastEpKey: item.key, lastLabel: 'episode' });
      try {
        const r = await resolveEpisode(env, item, runCtx);
        if (!r.transient) {
          epByKey.set(item.key, { name: r.name, overview: r.overview });
          episodeResolvedThisRun++;
        }
        return r;
      } catch {
        return null; // 单集异常按未解析处理，留给下一轮
      }
    },
    {
      shouldStop: () => Date.now() > deadline,
      onDone: (done) => {
        diagTouch({ epDoneCount: done });
        if (done % DIAG_MILESTONE_EPS === 0) diagFlushPoint();
      },
    }
  );

  // 7) 最终版：partial 表示本轮是否因时间盒提前停（还有 show 没解析
  //    到、或还有集没解析到）。v6：先落两张整表（dirty 才写，names
  //    在补名后检查点已落过一次、这里通常 no-op；eps 本轮唯一落盘
  //    点），再写最终快照（本轮第 3 次 buildAndWriteDays）。
  diagPhase('final');
  let finalStats;
  try {
    await persistKvTable(env, NAMES_TABLE_KEY, namesTable);
    await persistKvTable(env, EPS_TABLE_KEY, epsTable);
    finalStats = await buildAndWriteDays(env, days, perDay, bangumiRaw, nameByShowId, epByKey, {
      ...runBase,
      partial: completed < todo.length || epResult.completed < epTodo.length,
      resolvedThisRun,
      ...epRunStats(),
      ...tmdbRunCounts(),
    });
  } catch (e) {
    // v5-diag2：最终写失败也别让本轮无声消失——先把 phase 记成
    // final-error 并刷 diag，再尽力写一版最小 meta（partial=true），
    // 快照缺失留给下一轮；aggregate 照常返回、不抛错。
    diagTouch({ finalError: String(e?.message ?? e) });
    diagPhase('final-error');
    finalStats = {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      tmdbConfigured,
      showsResolved: showsById.size,
      partial: true,
      resolvedThisRun,
      remainUnresolved: showsById.size - nameByShowId.size,
      ...epRunStats(),
      ...tmdbRunCounts(),
      paceTimeouts: diag.paceTimeouts,
      kvTimeouts: diag.kvTimeouts,
      jsonTimeouts: diag.jsonTimeouts,
      diagPhase: 'final-error',
      days: {},
    };
    try {
      await kvPut(env, 'meta:lastRefresh', JSON.stringify({ at: finalStats.generatedAt, stats: finalStats }));
    } catch {
      // 最小 meta 也写不出时，至少 diag 已落盘
    }
  }
  // v5-diag 收尾：摘下 activeDiag 并刷最后一版 meta:diag，把
  // phase=final 的最终计数定格；之后本轮不再有任何计数进来。
  // v6：定格刷盘置 _finalFlush（不占每轮 put 硬顶），刷完置
  // _sealed 封盘——尾随定时器迟到触发也一律 no-op。
  if (diag._trailTimer) {
    clearTimeout(diag._trailTimer);
    diag._trailTimer = null;
  }
  if (activeDiag === diag) activeDiag = null;
  diag._finalFlush = true;
  await flushDiag(diag);
  diag._sealed = true;
  return finalStats;
}

// ---------------- HTTP 处理 ----------------

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function handleCalendar(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResp(
      { error: 'missing or invalid date, expected /calendar?date=YYYY-MM-DD' },
      400
    );
  }
  const snap = await env.CACHE.get(`day:${date}`);
  if (!snap) {
    return jsonResp(
      {
        error: `no snapshot for ${date}`,
        hint: 'snapshots cover the next 7 days (Asia/Shanghai) and refresh every 30 minutes; try POST /refresh or check /health',
      },
      404
    );
  }
  const etag = `"${fnv(snap)}"`;
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(snap, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
      ETag: etag,
    },
  });
}

async function handleHealth(env) {
  let meta = null;
  try {
    meta = await env.CACHE.get('meta:lastRefresh', { type: 'json' });
  } catch {
    meta = null;
  }
  // v5-diag：最近一轮聚合的诊断状态（meta:diag）原样带回，读不到为 null
  let diag = null;
  try {
    diag = await env.CACHE.get('meta:diag', { type: 'json' });
  } catch {
    diag = null;
  }
  const days = {};
  if (meta?.stats?.days) {
    for (const [d, c] of Object.entries(meta.stats.days)) {
      days[d] = c.entries;
    }
  }
  return jsonResp({
    ok: true,
    service: 'hbcalendar',
    lastRefreshAt: meta?.at ?? null,
    tmdbConfigured: !!env.TMDB_TOKEN,
    days,
    lastStats: meta?.stats ?? null,
    diag: diag ?? null,
  });
}

/// 诊断端点（v3，公开只读）：绕过补名缓存，实时对单个 TVmaze show
/// 跑一遍 computeShowName 并返回全程轨迹——某部剧迟迟匹配不上中文名
/// 时先看这里：steps 里 kind=failed 是瞬时失败（聚合下轮自动重试），
/// 全程 ok/notfound 却没中文名才是 TMDB 真没中文资料。返回的都是
/// 公开元数据（externals / TMDB 路径与状态 / 命中名），无任何密钥。
/// 注意：isCn 只能按 network/webChannel 国家推断（没有排期上下文），
/// 与聚合时「在 CN 排期出现过」的判定可能略有出入。
async function handleResolve(request, env) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('tvmaze') ?? '';
  if (!/^\d+$/.test(raw)) {
    return jsonResp(
      { error: 'missing or invalid id, expected /resolve?tvmaze=<TVmaze show id>' },
      400
    );
  }
  const id = Number(raw);
  const show = await fetchJson(`${TVMAZE}/shows/${id}`, { label: 'show' });
  if (!show || show.id == null) {
    return jsonResp(
      { error: `tvmaze show ${id} not found (or TVmaze unreachable)` },
      404
    );
  }
  const isCn = isChineseShow(show, new Set());
  const trace = [];
  const res = await computeShowName(env, show, isCn, trace);
  return jsonResp({
    tvmaze: id,
    show: {
      name: show.name ?? null,
      network: show.network?.name ?? show.webChannel?.name ?? null,
      language: show.language ?? null,
    },
    externals: show.externals ?? {},
    isCn,
    tmdbConfigured: !!env.TMDB_TOKEN,
    steps: trace,
    result: {
      title: res.title,
      via: res.via,
      tmdbId: res.tmdbId,
      poster: res.poster,
      overview: res.overview,
      transient: res.transient,
    },
    note: 'bypasses the name cache; transient=true means a TMDB step failed inconclusively — the aggregate retries next round instead of caching it',
  });
}

async function handleRefresh(request, env, ctx) {
  if (!env.REFRESH_KEY) {
    return jsonResp(
      { error: 'refresh disabled: REFRESH_KEY secret is not configured' },
      403
    );
  }
  if (request.headers.get('X-Refresh-Key') !== env.REFRESH_KEY) {
    return jsonResp({ error: 'unauthorized: bad X-Refresh-Key' }, 401);
  }
  // 立即返回、聚合在后台跑：整轮可能几分钟，等它跑完才回响应会被平台
  // 与客户端超时掐断（v1 就栽在这里，请求挂 5 分钟零产出）。聚合带
  // 检查点，进度与结果看 /health 的 lastRefreshAt / lastStats。
  ctx.waitUntil(aggregate(env));
  return jsonResp(
    { started: true, hint: 'poll /health for lastRefreshAt and per-day counts' },
    202
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/calendar' && request.method === 'GET') {
        return await handleCalendar(request, env);
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        return await handleHealth(env);
      }
      if (url.pathname === '/resolve' && request.method === 'GET') {
        return await handleResolve(request, env);
      }
      if (url.pathname === '/refresh' && request.method === 'POST') {
        return await handleRefresh(request, env, ctx);
      }
      if (url.pathname === '/' && request.method === 'GET') {
        return jsonResp({
          service: 'hbcalendar',
          endpoints: {
            'GET /calendar?date=YYYY-MM-DD': '某日成品日历快照（KV 直出）',
            'GET /health': '服务状态与最近刷新统计',
            'GET /resolve?tvmaze=<id>': '诊断：绕过缓存实时解析单个 show 的中文名，返回全程轨迹',
            'POST /refresh': '后台触发一轮聚合，立即返回 202（需 X-Refresh-Key 头）',
          },
        });
      }
      return jsonResp({ error: 'not found' }, 404);
    } catch (e) {
      return jsonResp({ error: `internal: ${e?.message ?? e}` }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(aggregate(env));
  },
};
