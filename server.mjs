// hbcalendar — HBPlayer 追剧日历预聚合服务（自托管 / Docker 版入口）
//
// 与 Cloudflare Worker 版共用同一份聚合逻辑（src/index.js 的 aggregate /
// computeShowName），本文件只负责三件事：
// 1) 给 index.js 提供一个「文件版 CACHE」适配器（接口与 Workers KV 对齐：
//    get(key) 返回原始字符串、get(key, {type:'json'}) 返回解析后对象、
//    put(key, value, opts) 支持 expirationTtl 秒级过期）；
// 2) 用 node:http 暴露与 Worker 版一致的 HTTP 端点：
//    GET /、GET /calendar?date=YYYY-MM-DD、GET /health、
//    GET /resolve?tvmaze=<id>、POST /refresh；
// 3) 内置调度：启动 5 秒后跑一轮 aggregate，之后每 AGG_INTERVAL_MS
//    （默认 1800000 = 30 分钟）跑一轮；/refresh 走同一条异步通道。
//
// 没有 Cloudflare 的子请求 / KV 写额度 / invocation 时限，自托管版经
// 环境变量把单轮时间盒与 TMDB 节流放宽（见 docker-compose.yml 的
// RUN_TIMEBOX_MS / TMDB_PACE_MS）；解析语义与 Worker 版完全一致。
//
// 环境变量：
//   DATA_DIR         数据目录（默认 ./data），一个 key 一个文件
//   PORT             监听端口（默认 8787）
//   TMDB_TOKEN       TMDB 只读访问令牌（未配置则跳过 TMDB 步）
//   REFRESH_KEY      /refresh 密钥（未配置则禁用该端点）
//   RUN_TIMEBOX_MS   单轮聚合时间盒（透传给 aggregate，缺省用 index.js 常量）
//   TMDB_PACE_MS     TMDB 节流间隔（透传给 aggregate，缺省 250）
//   AGG_INTERVAL_MS  聚合间隔（默认 1800000）

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { aggregate, computeShowName } from './src/index.js';

const TVMAZE = 'https://api.tvmaze.com';
const UA = 'HBPlayer/1.0 (hbcalendar-server)';

// ---------------- 文件版 CACHE 适配器 ----------------
//
// 一个 key 一个文件，文件名 = encodeURIComponent(key) + '.json'
// （':' '/' 等字符被转义，天然安全）。文件内容是信封 JSON：
//   { "exp": <毫秒时间戳|null>, "value": "<原始字符串>" }
// exp 来自 put 的 opts.expirationTtl（秒）或 opts.expiration（秒级
// epoch），读到已过期按未命中返回 null 并顺手删文件。
// 写入走「临时文件 + rename」，同一文件系统内 rename 是原子替换，
// 进程中途死掉也不会留下写一半的快照。

class FileKV {
  constructor(dir) {
    this.dir = dir;
    // 写失败计数：聚合层对写失败是静默吞的（不让单次写失败打崩整轮），
    // 这里留痕 + 首败大声报，避免「跑通了却存不下」的无声空转。
    this.putFailures = 0;
  }

  fileFor(key) {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  async get(key, opts) {
    let raw;
    try {
      raw = await fs.readFile(this.fileFor(key), 'utf8');
    } catch {
      return null; // 不存在 / 读失败 → 未命中（与 KV 口径一致）
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return null; // 文件损坏 → 按未命中，下轮聚合会重写
    }
    if (
      envelope &&
      typeof envelope.exp === 'number' &&
      envelope.exp <= Date.now()
    ) {
      fs.unlink(this.fileFor(key)).catch(() => {}); // 过期清理，失败静默
      return null;
    }
    const value = envelope?.value ?? null;
    if (value == null) return null;
    if (opts && opts.type === 'json') {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return value;
  }

  async put(key, value, opts) {
    try {
      let exp = null;
      if (opts && typeof opts.expirationTtl === 'number') {
        exp = Date.now() + opts.expirationTtl * 1000;
      } else if (opts && typeof opts.expiration === 'number') {
        exp = opts.expiration * 1000;
      }
      const envelope = JSON.stringify({ exp, value: String(value) });
      await fs.mkdir(this.dir, { recursive: true });
      const target = this.fileFor(key);
      const tmp = `${target}.tmp-${process.pid}-${Math.random()
        .toString(36)
        .slice(2)}`;
      await fs.writeFile(tmp, envelope, 'utf8');
      await fs.rename(tmp, target); // 原子落盘
    } catch (e) {
      this.putFailures++;
      if (this.putFailures === 1) {
        console.error(
          `[hbcalendar] ERROR: 数据目录写入失败（${this.dir}）：${e?.message ?? e} —— ` +
            '聚合结果将无法落盘，请检查目录权限（docker bind 挂载的 ./data 属主应为 uid 1000）'
        );
      }
      throw e; // 调用方（index.js 的 kvPut / flushDiag）本就按写失败处理
    }
  }

  async delete(key) {
    try {
      await fs.unlink(this.fileFor(key));
    } catch {
      // 不存在即已删
    }
  }
}

// ---------------- index.js 未导出的小工具（等价复制） ----------------

/// 简单字符串哈希（ETag 用，FNV-1a）——与 src/index.js 同实现
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/// 是否国产 show——与 src/index.js 同判定（判据含 language==='Chinese'
/// 这一条：iQIYI 等频道的 webChannel.country 为 null 时靠它补判；
/// 两处必须同步改）
function isChineseShow(show, cnShowIds) {
  return (
    cnShowIds.has(show.id) ||
    show?.network?.country?.code === 'CN' ||
    show?.webChannel?.country?.code === 'CN' ||
    show?.language === 'Chinese'
  );
}

/// 带超时的 JSON 拉取；失败/非 2xx 返回 null（/resolve 拉 TVmaze show 用，
/// 口径与 src/index.js 的 fetchJson 一致，此处取其等价短版）
async function fetchJson(url, { headers = {}, timeoutMs = 20000 } = {}) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// ---------------- env 组装 ----------------

const DATA_DIR = process.env.DATA_DIR || './data';
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787;
const AGG_INTERVAL_MS =
  Number(process.env.AGG_INTERVAL_MS) > 0
    ? Number(process.env.AGG_INTERVAL_MS)
    : 1800000;

const env = {
  CACHE: new FileKV(DATA_DIR),
  TMDB_TOKEN: process.env.TMDB_TOKEN || null,
  REFRESH_KEY: process.env.REFRESH_KEY || null,
  // 透传给 aggregate 的放宽参数：字符串原样传入，index.js 内 Number()
  // 判定合法正数才采用；未配置（undefined）时回落 Worker 版缺省。
  RUN_TIMEBOX_MS: process.env.RUN_TIMEBOX_MS || undefined,
  TMDB_PACE_MS: process.env.TMDB_PACE_MS || undefined,
};

// ---------------- 聚合调度（防重入） ----------------

let aggRunning = false;

async function runAggregateOnce(trigger) {
  if (aggRunning) {
    console.log(`[aggregate] skip (${trigger}): previous run still in progress`);
    return false;
  }
  aggRunning = true;
  const t0 = Date.now();
  try {
    const stats = await aggregate(env);
    console.log(
      `[aggregate] done (${trigger}): ${stats.durationMs}ms, ` +
        `resolvedThisRun=${stats.resolvedThisRun}, remain=${stats.remainUnresolved}, ` +
        `episodes +${stats.episodeResolvedThisRun ?? 0}, ` +
        `writeFailures=${env.CACHE.putFailures ?? 0}`
    );
    return true;
  } catch (e) {
    console.error(
      `[aggregate] failed (${trigger}) after ${Date.now() - t0}ms:`,
      e?.message ?? e
    );
    return false;
  } finally {
    aggRunning = false;
  }
}

// ---------------- HTTP 处理（与 Worker 版行为一致） ----------------

function sendJson(res, obj, status = 200, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

async function handleCalendar(req, res, url) {
  const date = url.searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return sendJson(
      res,
      { error: 'missing or invalid date, expected /calendar?date=YYYY-MM-DD' },
      400
    );
  }
  const snap = await env.CACHE.get(`day:${date}`);
  if (!snap) {
    return sendJson(
      res,
      {
        error: `no snapshot for ${date}`,
        hint: 'snapshots cover the next 7 days (Asia/Shanghai) and refresh every 30 minutes; try POST /refresh or check /health',
      },
      404
    );
  }
  const etag = `"${fnv(snap)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=600',
    ETag: etag,
  });
  res.end(snap);
}

async function handleHealth(res) {
  let meta = null;
  try {
    meta = await env.CACHE.get('meta:lastRefresh', { type: 'json' });
  } catch {
    meta = null;
  }
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
  return sendJson(res, {
    ok: true,
    service: 'hbcalendar',
    lastRefreshAt: meta?.at ?? null,
    tmdbConfigured: !!env.TMDB_TOKEN,
    days,
    lastStats: meta?.stats ?? null,
    diag: diag ?? null,
  });
}

async function handleResolve(res, url) {
  const raw = url.searchParams.get('tvmaze') ?? '';
  if (!/^\d+$/.test(raw)) {
    return sendJson(
      res,
      { error: 'missing or invalid id, expected /resolve?tvmaze=<TVmaze show id>' },
      400
    );
  }
  const id = Number(raw);
  const show = await fetchJson(`${TVMAZE}/shows/${id}`);
  if (!show || show.id == null) {
    return sendJson(
      res,
      { error: `tvmaze show ${id} not found (or TVmaze unreachable)` },
      404
    );
  }
  const isCn = isChineseShow(show, new Set());
  const trace = [];
  const result = await computeShowName(env, show, isCn, trace);
  return sendJson(res, {
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
      title: result.title,
      via: result.via,
      tmdbId: result.tmdbId,
      poster: result.poster,
      overview: result.overview,
      transient: result.transient,
    },
    note: 'bypasses the name cache; transient=true means a TMDB step failed inconclusively — the aggregate retries next round instead of caching it',
  });
}

function handleRefresh(req, res) {
  if (!env.REFRESH_KEY) {
    return sendJson(
      res,
      { error: 'refresh disabled: REFRESH_KEY secret is not configured' },
      403
    );
  }
  if (req.headers['x-refresh-key'] !== env.REFRESH_KEY) {
    return sendJson(res, { error: 'unauthorized: bad X-Refresh-Key' }, 401);
  }
  // 立即返回、聚合在后台跑（与 Worker 版 ctx.waitUntil 同口径）；
  // 已有轮次在跑时防重入会跳过本轮，进度看 /health。
  void runAggregateOnce('refresh');
  return sendJson(
    res,
    { started: true, hint: 'poll /health for lastRefreshAt and per-day counts' },
    202
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/calendar' && req.method === 'GET') {
      return await handleCalendar(req, res, url);
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      return await handleHealth(res);
    }
    if (url.pathname === '/resolve' && req.method === 'GET') {
      return await handleResolve(res, url);
    }
    if (url.pathname === '/refresh' && req.method === 'POST') {
      return handleRefresh(req, res);
    }
    if (url.pathname === '/' && req.method === 'GET') {
      return sendJson(res, {
        service: 'hbcalendar',
        endpoints: {
          'GET /calendar?date=YYYY-MM-DD': '某日成品日历快照（KV 直出）',
          'GET /health': '服务状态与最近刷新统计',
          'GET /resolve?tvmaze=<id>': '诊断：绕过缓存实时解析单个 show 的中文名，返回全程轨迹',
          'POST /refresh': '后台触发一轮聚合，立即返回 202（需 X-Refresh-Key 头）',
        },
      });
    }
    return sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    return sendJson(res, { error: `internal: ${e?.message ?? e}` }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`[hbcalendar] listening on :${PORT}, data dir: ${DATA_DIR}`);
  console.log(
    `[hbcalendar] TMDB_TOKEN: ${env.TMDB_TOKEN ? 'configured' : 'NOT set (跳过 TMDB 步)'}, ` +
      `REFRESH_KEY: ${env.REFRESH_KEY ? 'configured' : 'NOT set (/refresh 禁用)'}, ` +
      `interval: ${AGG_INTERVAL_MS}ms`
  );
  // 启动探写：数据目录写不进去时，聚合会「跑通但存不下」（写失败在聚合
  // 层静默），/health 会一直是空的。开机先探一笔，写不了立刻大声报。
  void (async () => {
    const probe = path.join(DATA_DIR, '.write-probe');
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(probe, 'ok', 'utf8');
      await fs.unlink(probe);
    } catch (e) {
      console.error(
        `[hbcalendar] ERROR: 数据目录 ${DATA_DIR} 不可写（${e?.message ?? e}），聚合结果无法落盘！` +
          '若用 docker compose 的 ./data bind 挂载且该目录由 root 创建：先执行 ' +
          'sudo chown -R 1000:1000 ./data 再重启容器。'
      );
    }
  })();
});

// 启动 5 秒后先跑一轮，之后按间隔滚动；进程常驻即调度常驻。
setTimeout(() => void runAggregateOnce('boot'), 5000);
setInterval(() => void runAggregateOnce('interval'), AGG_INTERVAL_MS);
