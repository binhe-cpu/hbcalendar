# 本地实测记录

- 时间：2026-11-10（Asia/Shanghai）
- 环境：Node v24.22.1，本机真实网络（TVmaze / Bangumi 直连）
- 方式：`node scripts/local_run.mjs`（内存 KV 桩 + `aggregate()` 真跑一轮，未来 7 天）
- **本轮未提供 TMDB_TOKEN**：TMDB 步按设计整体跳过（`tmdbConfigured=false`），
  下面所有中文名均来自 TVmaze akas 兜底与 Bangumi；TMDB 命名覆盖率待部署后
  配好 secret 再用 `POST /refresh` 实测（预期 tmdbNamed 显著高于本轮的 0）。

## 聚合实测输出

```
== hbcalendar local run ==
node: v24.22.1
TMDB_TOKEN: NOT set (跳过 TMDB 步)

聚合完成：21688 ms，解析 show 599 部
逐日统计（date: entries / tmdbNamed / akaNamed）：
  2026-11-10: 200 / 0 / 30
  2026-11-11: 223 / 0 / 27
  2026-11-12: 214 / 0 / 24
  2026-11-13: 184 / 0 / 21
  2026-11-14: 111 / 0 / 13
  2026-11-15: 140 / 0 / 13
  2026-11-16: 122 / 0 / 12

总条目 1194，其中中文标题条目 211，不同中文剧名 100 个
中文剧名样本（前 20）：
  乱世千金倪亚‧利斯顿转生为娇弱千金的弑神武人华丽无双录
  冷淡的佐藤同学只对我撒娇
  幻想水浒传
  弹珠汽水瓶里的千岁同学 第2部分
  战斗之魂[Re] 绝界之空
  暗机 DARK MACHINE
  被放逐的作弊赋予魔术师享受随心所欲的第二人生。
  赛博朋克：边缘行者 2
  超巡！超条前辈
  万界独尊
  吞噬星空
  天命·成凰
  一斩苍穹
  三十六计杀
  今天是太阳雨
  以下犯上
  凤起于渊
  十三种爱情
  我心安处是桃源
  走马上任

点名核对：
  吞噬星空: OK（2026-11-10 tvmaze-schedule）
  逆天至尊: OK（2026-11-13 tvmaze-schedule）
  尚公主: OK（2026-11-10 tvmaze-schedule）
  以下犯上: OK（2026-11-10 tvmaze-schedule）
  折月亮: OK（2026-11-10 tvmaze-schedule）
  天命·成凰: OK（2026-11-10 tvmaze-schedule）
  拼音残留 'Tunshi Xingkong': 0 条（正常）

带 tmdbCoverUrl 的条目：0（本轮无 TMDB_TOKEN，预期为 0）
== done ==
```

要点：

- 仅靠 akas 兜底，国产剧命名已全中：点名 6 部全 OK；
  **吞噬星空是中文名、拼音残留 0**（aka 选取优先含 CJK 的规则生效——
  该剧 CN aka 第一位是拼音 'Tunshi Xingkong'、第二位才是中文名）。
- 单日条目量级与 App 客户端直拉一致（111–223 条/天）。
- 一轮聚合约 22 秒（本地、含 28 份排期 + 599 部 show 的补名解析；
  部署后 cron 在 Cloudflare 侧跑，客户端无感）。

## 端点冒烟（同一内存 KV，import Worker fetch handler 直调）

```
health(before):        200
calendar(no snapshot): 404   （无快照按契约返 404 + hint）
calendar(bad date):    400
refresh(no key):       401
refresh(wrong key):    401
root /:                200
unknown path:          404
refresh(ok):           200，days=7，tmdbConfigured=false
calendar(after):       200，entries=200，ETag="73ef98ff"，Cache-Control: public, max-age=600
calendar(If-None-Match): 304
health(after):         ok=true，lastRefreshAt 有值，days={11-10:200, 11-11:223, 11-12:214, 11-13:184, 11-14:111, 11-15:140, 11-16:122}
```

另：`REFRESH_KEY` 未配置时 `/refresh` 返 403 禁用（代码分支已核，未在此轮单独跑）。

---

## v2（检查点 + 时间盒）复测 — 2026-11-10

背景：v1 已由用户控制台部署上线，但首轮 /refresh 挂 5 分钟以上零产出
（全有全无结构：约 600 部 show 补完名才写第一份快照，Cloudflare 冷缓存
一轮几分钟起、被平台终止后缓存永远暖不起来）。v2 改动：单轮约 50 秒
时间盒、检查点写快照（补名前 / 每满约 60 部 / 结束共三版）、补名改滚动
并发池、在轮重试瘦身（TMDB 2 次尝试 / 超时 10s / 退避 800ms，排期与
Bangumi 超时 15s）、/refresh 改 waitUntil 后台跑 + 立即返回 202。

### ① 无令牌全量（node scripts/local_run.mjs，与 v1 同口径）

```
聚合完成：12437 ms，解析 show 599 部
逐日统计（date: entries / tmdbNamed / akaNamed）：
  2026-11-10: 200 / 0 / 30
  2026-11-11: 223 / 0 / 27
  2026-11-12: 214 / 0 / 24
  2026-11-13: 184 / 0 / 21
  2026-11-14: 111 / 0 / 13
  2026-11-15: 140 / 0 / 13
  2026-11-16: 122 / 0 / 12
总条目 1194，中文标题条目 211，不同中文剧名 100 个
点名核对 6 部全 OK，拼音残留 'Tunshi Xingkong' 0 条
```

与 v1 基线逐项一致（条数 / akaNamed / 中文名覆盖全同），本轮 12.4 秒
跑完、partial 未触发。

### ② 时间盒回归（node scripts/test_timebox.mjs）

TMDB 打桩为每次调用固定延迟 30 秒（遵循 AbortSignal，被 10s 超时掐断
后重试 1 次）、假令牌、冷缓存；TVmaze / Bangumi 真网络。断言全过：

```
aggregate 返回：94570 ms（TMDB 桩被调 38 次）
partial=true resolvedThisRun=10 remainUnresolved=589 shows=599
  [PASS] aggregate 在 100 秒内返回 — 94570 ms
  [PASS] 7 天 day: 快照全部落 KV — 7/7
  [PASS] stats.partial === true
  [PASS] remainUnresolved > 0（未解析的留给下一轮） — remain=589
  [PASS] meta:lastRefresh 已写
== ALL PASS ==
```

耗时构成：前置拉排期走本沙箱代理较慢，补名第一波在飞任务（单个 show
最长约 3 次 TMDB 请求 × 约 21 秒）在时间盒到点后排空所致；Cloudflare
侧网络快得多，实际会明显短于此。关键语义已验：到点即停、不写未解析
show 的缓存、快照与 meta 在补名跑完前就已落盘。

---

## v3（失败不冻结 + /resolve 诊断）复测 — 2026-11-10

背景：v2 已部署上线（快照齐、cron 正常、热轮 3.9 秒），但抽查发现
TVmaze 90035《The Remarried Empress》（externals 齐全：imdb tt39325975、
thetvdb 455351；TMDB 确有中文条目「再婚皇后」）在条目里没有
tmdbCoverUrl/tmdbOverview——TMDB id 根本没解析出来，且失败结果被当
负缓存以 7 天 TTL 冻结。同期全周有 28 条 tmdbNamed、72 条带 TMDB
海报，机制本身是通的，失败是冷启动风暴里的偶发（429/超时/5xx）；
旧代码把「查无此名」与「查询失败」都塌缩成 null、无从分辨。

v3 改动：

- **TMDB 结果分型**：tmdbFetch 返回 `ok / notfound（有结论）/ failed
  （瞬时失败）`；computeShowName 全程跟踪，任一步 failed 且最终没
  拿到中文名 → 结果标 `transient`、**不落盘**（本轮内存照常用原名/
  aka 名，下轮 cron 自动重试）；只有全程有结论才落负缓存，正结果
  落盘不变。
- **缓存换代**：补名缓存键前缀 `showname:` → `showname2:`，风暴期
  已冻住的可疑负缓存整体作废（正结果随后续轮次自动重建）。
- **诊断端点** `GET /resolve?tvmaze=<id>`（公开只读）：绕过缓存实时
  解析单个 show，返回 externals、每步 TMDB 调用的 path/kind/HTTP
  状态、search 命中、detail 名与是否含中文、aka 兜底、最终名与 via。

### ① 无令牌全量（node scripts/local_run.mjs，与 v2 同口径）

```
聚合完成：12983 ms，解析 show 599 部
逐日统计（date: entries / tmdbNamed / akaNamed）：
  2026-11-10: 200 / 0 / 30
  2026-11-11: 223 / 0 / 27
  2026-11-12: 214 / 0 / 24
  2026-11-13: 184 / 0 / 21
  2026-11-14: 111 / 0 / 13
  2026-11-15: 140 / 0 / 13
  2026-11-16: 122 / 0 / 12
总条目 1194，中文标题条目 211，不同中文剧名 100 个
点名核对 6 部全 OK，拼音残留 'Tunshi Xingkong' 0 条
```

与 v1/v2 基线逐项一致。

### ② 时间盒回归（node scripts/test_timebox.mjs）

```
aggregate 返回：92338 ms（TMDB 桩被调 38 次）
partial=true resolvedThisRun=10 remainUnresolved=589 shows=599
  [PASS] aggregate 在 100 秒内返回 — 92338 ms
  [PASS] 7 天 day: 快照全部落 KV — 7/7
  [PASS] stats.partial === true
  [PASS] remainUnresolved > 0（未解析的留给下一轮） — remain=589
  [PASS] meta:lastRefresh 已写
== ALL PASS ==
```

### ③ 瞬时失败不落盘回归（node scripts/test_resolve.mjs，新增）

夹具即 90035 本尊（externals 齐全、非国产、无 aka 步）：

```
场景一：TMDB 全程 429
  [PASS] 结果标 transient — transient=true
  [PASS] 本轮内存结果照常返回（原名顶着） — title=The Remarried Empress via=none
  [PASS] KV 里没有 showname2:90035（不落盘）
  [PASS] KV 里也没有旧前缀 showname:90035
场景二：TMDB 有结论但无中文名（find 命中 id、detail 返回英文名）
  [PASS] 结果不标 transient — transient=false
  [PASS] 负结果已落盘 showname2:90035 — via=none
  [PASS] 落盘内容为原名、无 TMDB 采用
  [PASS] trace: find_imdb kind=ok 且只调一次 find（命中即止）
  [PASS] trace: detail_name 记录且 hasCjk=false
== ALL PASS ==
```

### ④ /resolve 端点冒烟（临时脚本，打桩后已删）

TMDB 打桩全程 429、TVmaze /shows 走夹具：无参返 400、未知 id 返
404、`/resolve?tvmaze=90035` 返 200 且轨迹恰好复现线上故障形状——
三步（find_imdb / find_tvdb / search）全 `kind:'failed'`、status 429、
attempts 2，最终 `result.transient=true, via='none'`；根路径端点
一览已含 /resolve。

---

## v4（集级中文下沉服务端）复测 — 2026-11-10

背景：v3 后剧级中文名已在服务端解析，但详情页的集名 / 集简介中文
仍靠客户端进页实时查 TMDB（吃用户本地网络抖动）。v4 把这层也搬到
服务端：聚合在剧名解析后新增「集解析」阶段（共用同一 50 秒时间盒
与检查点节奏）——对已解析出 tmdbId 的集按 (tmdbId, 季, 集) 去重成
队列、按 airDate 先后逐个查 TMDB 集详情（zh-CN），查到中文的字段
才覆盖条目 episodeTitle / overview（逐字段独立判定，查不到的字段
保持 TVmaze 原值），客户端零改动即受益。结论按
`ep:{tmdbId}:{s}:{e}` 缓存：至少一字段有中文 = 正结果 TTL 30 天；
有结论无中文 = 负结果 TTL 7 天；瞬时失败（沿用 v3 分型）不落盘、
下轮重试。stats 新增 episodeResolved / episodeResolvedThisRun /
episodeRemain，/health 可看集解析进度。剧名阶段、端点、既有 KV 键
与条目字段语义全不变；Bangumi 条目与无 tmdbId 的条目跳过。

### ① 无令牌全量（node scripts/local_run.mjs，与 v3 同口径）

```
聚合完成：13725 ms，解析 show 599 部
逐日统计（date: entries / tmdbNamed / akaNamed）：
  2026-11-10: 200 / 0 / 30
  2026-11-11: 223 / 0 / 27
  2026-11-12: 214 / 0 / 24
  2026-11-13: 184 / 0 / 21
  2026-11-14: 111 / 0 / 13
  2026-11-15: 140 / 0 / 13
  2026-11-16: 122 / 0 / 12
总条目 1194，中文标题条目 211，不同中文剧名 100 个
点名核对 6 部全 OK，拼音残留 'Tunshi Xingkong' 0 条
集统计（另跑一轮单独打印 stats）：episodeResolved=0
  episodeResolvedThisRun=0 episodeRemain=0
```

与 v1/v2/v3 基线逐项一致；无令牌时没有任何 show 能解析出 tmdbId，
集队列为空、集阶段整体跳过，三个集统计字段为 0（符合设计）。

### ② 时间盒回归（node scripts/test_timebox.mjs）

```
aggregate 返回：91495 ms（TMDB 桩被调 44 次）
partial=true resolvedThisRun=12 remainUnresolved=587 shows=599
  [PASS] aggregate 在 100 秒内返回 — 91495 ms
  [PASS] 7 天 day: 快照全部落 KV — 7/7
  [PASS] stats.partial === true
  [PASS] remainUnresolved > 0（未解析的留给下一轮） — remain=587
  [PASS] meta:lastRefresh 已写
== ALL PASS ==
```

TMDB 桩调用数较 v3 的 38 次略增：时间盒内多解析出几部带 tmdbId
的 show 后，其集详情也开始被尝试（仍受同一时间盒约束、到点即停）。

### ③ 集解析回归（node scripts/test_episode.mjs，新增）

全打桩夹具：一部剧（TVmaze 70001 → TMDB 88001「夹具剧」）4 集，
TMDB 集详情分别造「双字段中文 / 只有集名中文 / 全程 429 / 有结论
全英文」四种情形；第二轮同 env 验缓存命中：

```
第一轮（冷缓存）：
  stats: episodeResolved=3 episodeResolvedThisRun=3 episodeRemain=1
  [PASS] e1 集名被中文覆盖 / 集简介被中文覆盖
  [PASS] e2 只覆盖集名、简介保持 TVmaze 原值
  [PASS] e3（429）字段保持原值、不落盘、本轮确有被调用
  [PASS] e4（有结论全英文）字段保持原值
  [PASS] e1/e2 正结果落 ep: 键、TTL 30 天（一字段中文即正结果）
  [PASS] e4 负结果落 ep: 键、TTL 7 天
第二轮（同 env）：
  stats: episodeResolved=3 episodeResolvedThisRun=0 episodeRemain=1
  [PASS] e1/e2/e4 集详情零 TMDB 调用（缓存命中）
  [PASS] e3 因 transient 未落盘被重新调用（设计如此）
  [PASS] 剧名 find 零调用（showname2 缓存命中）
  [PASS] 快照里 e1/e2 中文照旧（缓存 seed 回填）
== ALL PASS ==
```

## v5（TMDB 节流 + 429 尊重 Retry-After）复测 — 2026-11-10

背景：v3/v4 上线后剧名冷启动收敛在最后一小时停滞——remainUnresolved
384→391 反升、全周中文标题 2 小时只 +9；每轮毛解析 129~160 部却净
减少极小，而 /resolve 单条调用即时成功（find 200 一次命中），说明
不是令牌与通路问题。最可信的解释是批量轮次里 TMDB 并发过高触发限
流（429），大量解析以瞬时失败收场、不落缓存，下轮重查同一批 show，
白白烧掉时间盒；集解析同理被饿在时间盒之外。v5：①模块级节流链，
所有 tmdbFetch 起步间隔 ≥250ms（约 4 请求/秒）；②并发池剧名/集
解析 6→3；③429 读 Retry-After（秒，封顶 5 秒）再重试一次，其他
5xx/超时仍 800ms 退避一次；④stats 新增 tmdbOkThisRun /
tmdbFailedThisRun，检查点与最终 meta 都带上，下次验收直接读失败率；
⑤补名到点就停落到 show 内：computeShowName 每步前先看是否已过
时间盒，过了按未完成返回（transient、不落盘），防止串行慢调用把
单轮拖过时限。口径、端点、KV 键、字段语义全不变；仍是同一时间盒+
检查点骨架。

### ① 无令牌全量（node scripts/local_run.mjs，与 v4 同口径）

```
聚合完成：12683 ms，解析 show 599 部
逐日统计（date: entries / tmdbNamed / akaNamed）：
  2026-11-10: 200 / 0 / 30
  2026-11-11: 223 / 0 / 27
  2026-11-12: 214 / 0 / 24
  2026-11-13: 184 / 0 / 21
  2026-11-14: 111 / 0 / 13
  2026-11-15: 140 / 0 / 13
  2026-11-16: 122 / 0 / 12
总条目 1194，中文标题条目 211，不同中文剧名 100 个
点名核对 6 部全 OK，拼音残留 'Tunshi Xingkong' 0 条
```

与 v1–v4 基线逐项一致；无令牌时 TMDB 步整体跳过，节流链无调用可
排，不影响口径。

### ② 时间盒回归（node scripts/test_timebox.mjs）

```
aggregate 返回：70339 ms（TMDB 桩被调 18 次）
partial=true resolvedThisRun=7 remainUnresolved=592 shows=599
  [PASS] aggregate 在 100 秒内返回 — 70339 ms
  [PASS] 7 天 day: 快照全部落 KV — 7/7
  [PASS] stats.partial === true
  [PASS] remainUnresolved > 0（未解析的留给下一轮） — remain=592
  [PASS] meta:lastRefresh 已写
== ALL PASS ==
```

注意：首跑曾 112530 ms 失败——时间盒只拦「取新任务」，一个 show
内的 find→search→detail 是串行的，慢调用（桩 30s、10s 超时掐断
后重试）在时间盒后仍可再跑约 62 秒。已在 v5 内补修：computeShowName
每步前先看是否已过时间盒，过了按未完成（transient、不落盘）返回，
单轮因此回到 70.3 秒。TMDB 桩调用数由 v4 的 44 次降至 18 次，正是
到点即停生效的体现（少做的调用下轮 cron 继续）。

### ③ 失败不冻结回归（node scripts/test_resolve.mjs）

```
场景一：TMDB 全程 429
  [PASS] 结果标 transient
  [PASS] 本轮内存结果照常返回（原名顶着）
  [PASS] KV 里没有 showname2:90035（不落盘）
  [PASS] KV 里也没有旧前缀 showname:90035
场景二：TMDB 有结论但无中文名
  [PASS] 结果不标 transient
  [PASS] 负结果已落盘 showname2:90035
  [PASS] 落盘内容为原名、无 TMDB 采用
  [PASS] trace: find_imdb kind=ok 且只调一次 find（命中即止）
  [PASS] trace: detail_name 记录且 hasCjk=false
== ALL PASS ==
```

场景一在 v5 下多走了 Retry-After 分支：桩未给 Retry-After 头，
回落 800ms 退避，结论不变。

### ④ 集解析回归（node scripts/test_episode.mjs）

```
第一轮（冷缓存）：
  stats: episodeResolved=3 episodeResolvedThisRun=3 episodeRemain=1
  [PASS] e1 集名被中文覆盖 / 集简介被中文覆盖
  [PASS] e2 只覆盖集名、简介保持 TVmaze 原值
  [PASS] e3（429）字段保持原值、不落盘、本轮确有被调用
  [PASS] e4（有结论全英文）字段保持原值
  [PASS] e1/e2 正结果落 ep: 键、TTL 30 天（一字段中文即正结果）
  [PASS] e4 负结果落 ep: 键、TTL 7 天
第二轮（同 env）：
  stats: episodeResolved=3 episodeResolvedThisRun=0 episodeRemain=1
  [PASS] e1/e2/e4 集详情零 TMDB 调用（缓存命中）
  [PASS] e3 因 transient 未落盘被重新调用（设计如此）
  [PASS] 剧名 find 零调用（showname2 缓存命中）
  [PASS] 快照里 e1/e2 中文照旧（缓存 seed 回填）
== ALL PASS ==
```

集解析池 6→3、节流链介入后结论逐项不变；e3 第二轮调用 2 次
（含一次重试）符合 429 后 800ms 退避（桩无 Retry-After 头）。

### ⑤ 节流回归（node scripts/test_pacing.mjs，新增）

全打桩，直接调 tmdbFetch（已 export）：

```
场景 A：50 次并发 tmdbFetch（即时 200）
  [PASS] 50 次调用全部 kind=ok
  [PASS] 50 次调用恰好发出 50 次请求 — calls=50
  [PASS] 任意 10 秒窗口内 TMDB 调用 ≤ 45 次 — max=40
  [PASS] 起步间隔中位数 ≥ 200ms（名义 250ms） — median=251ms
  [PASS] 50 次调用总耗时 ≥ 11 秒（节流真实生效） — 12275ms
场景 B：429 + Retry-After: 2 → 重试一次后成功
  [PASS] 结果 kind=ok（重试后成功）
  [PASS] 第二次调用晚到 ≥ 1.9 秒（Retry-After 被遵守） — 2001ms
  [PASS] 总耗时 ≥ 1.9 秒 — 2249ms
场景 C：Retry-After: 30 封顶 5 秒
  [PASS] 结果 kind=ok
  [PASS] 重试间隔约 5 秒（封顶，不超 6 秒） — 5001ms
场景 D：两次都 429 → failed
  [PASS] 结果 kind=failed
== ALL PASS ==
```

场景 A 的 10 秒窗口最大值 40 次，正好是 4 请求/秒 × 10 秒的设
计值；场景 B/C 的重试间隔与 Retry-After 头的秒数逐毫秒对得上。
