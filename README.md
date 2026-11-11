# hbcalendar — HBPlayer 追剧日历预聚合服务

一个可自托管的小服务（Docker 镜像 / Cloudflare Worker 两种部署形态，共用同一套聚合代码）。把追剧日历「全局轨」的聚合从客户端搬到服务端：
定时拉 TVmaze 四份排期 + Bangumi 动画周表，在服务端一次拼齐 TMDB
中文名 / 海报 / 简介，生成未来 7 天的逐日成品快照存 KV；App 进日历时
一天只打一个请求拿成品，不再在用户设备上现场多源直拉 + 逐个补名
（那套逻辑保留为后端不可用时的回落）。

- **只干全局轨**：在追（个人轨）不进后端，仍由 App 用本地收藏/历史合并。
- **补名在服务端做**：TMDB 从 Cloudflare 网络发（稳、带重试），结果按
  show 缓存全用户/全设备共享；用户本地网络对 TMDB 的抖动不再影响命名。
- TMDB 令牌只存后端一份（Worker secret），App 端不需要为日历配令牌。

## 工作方式

```
Cron（每 30 分钟） / POST /refresh
        │
        ▼
 aggregate()：
   1. TVmaze /schedule/web + /schedule?country=CN|US|JP × 未来 7 天
      （按集 id 去重；CN 集与 web 集大量重叠，去重后按 show id 认国产）
   2. 按 show 解析中文名（KV 整表缓存 names:v2，含负结果，exp 7 天）：
      a. TMDB 优先：externals(imdb→thetvdb) → /find 精确换 id →
         /tv/{id}?language=zh-CN，name 含中文才采用；find 落空用原名
         /search/tv 标题搜索兜底（全等优先、无全等只认首条且归一化互含）；
         失败只重试 1 次（退避 800ms、单次超时 10s——cron 每 30 分钟
         自动再来，轮内不死等）。海报与 show 级 zh 简介一并带回。
         **v5 节流**：全部 TMDB 调用共享节流链（起步间隔 ≥250ms、
         约 4 请求/秒），剧名/集解析并发各 3；429 时按 Retry-After
         等待（封顶 5 秒）再重试；stats 带 tmdbOkThisRun /
         tmdbFailedThisRun 可直接看失败率。
         **v5-diag 诊断**：聚合全程维护诊断状态（当前阶段 phase、
         补名进度、节流链/TMDB 调用进出计数、最近步骤与 show id、
         三类超时计数），在阶段变化、补名每满 10 部、任一超时发生
         时刷到 KV 键 `meta:diag`，/health 以 `diag` 字段原样带回
         ——轮次若再卡死，看 phase / doneCount / lastLabel 就能定位
         冻在哪一步。同时 resp.json() body 读取（10 秒）、补名链路
         KV get/put（8 秒）、tmdbPace slot 等待（10 秒链活性看门
         狗）都带超时护栏，单点挂死会被计入最终 stats 的
         jsonTimeouts / kvTimeouts / paceTimeouts 并按失败处理，
         不再整轮无声冻结。解析语义与 v5 完全一致。
      b. 国产 show（CN 排期出现过，或播出平台国家为 CN）TMDB 没中文名时，
         回落 TVmaze /shows/{id}/akas：CN 别名优先取第一个含中文的。
      c. 都没有 → 保留 TVmaze 原名。
      d. 失败不冻结（v3）：TMDB 结果分型——429/5xx/超时等瞬时失败
         （failed）不等于「查无此名」（notfound，有结论）。任一步 failed
         且最终没拿到中文名的结果只在本轮内存里用（原名/aka 名顶着），
         不落盘，下一轮 cron 自动重新解析；只有全程有结论的结果才
         落盘（正结果与负结果都是）。
   3. Bangumi /calendar（按天 KV 缓存一份）：人气门槛 votes/doing ≥50、
      与排期按标题去重、每日 ≤40 条合入。
   4. 集简介取 TVmaze 集 summary（剥 HTML，无则回落剧级 summary）。
   5. 检查点写快照（v2；v6 收敛）：排期 + Bangumi 就绪先写一版（名字
      先用整表已缓存的 + 原名），补名结束写一版，结束写最终版——一轮
      至多 3 次；快照内容没变的日期跳过写入；单轮约 50 秒时间盒，超
      时未解析的 show 不入表、留给下一轮 cron 续跑——名字逐轮补齐
      （看 /health 的 lastStats.remainUnresolved 逐轮递减），不再
      一轮跑不完就颗粒无收。
        │
        ▼
 KV：day:YYYY-MM-DD 成品快照（未来 7 天逐日一份）
        │
        ▼
 App ── GET /calendar?date=YYYY-MM-DD ──► 快照直出（ETag / Cache-Control）
```

## 端点

| 端点 | 说明 |
|---|---|
| `GET /calendar?date=YYYY-MM-DD` | 读 KV 快照直出 JSON，带 `Cache-Control: public, max-age=600` 与 `ETag`（支持 If-None-Match → 304）。该日无快照返 404 + hint；日期格式不对返 400。 |
| `GET /health` | `{ ok, lastRefreshAt, tmdbConfigured, days: {日期: 条目数}, lastStats }`，看最近一轮刷新时间、各天条数与命名计数。 |
| `GET /resolve?tvmaze=<id>` | 诊断端点（公开只读，返回的都是公开元数据）：绕过补名缓存，实时跑一遍该 show 的解析并返回轨迹——externals、每步 TMDB 调用的 path/kind/HTTP 状态、search 命中情况、detail 的 name 与是否含中文、aka 兜底结果、最终采用名与 via、是否 transient。id 格式错返 400，TVmaze 查无此剧返 404。某部剧匹配不上中文名时先看它（见常见问题）。 |
| `POST /refresh` | 后台触发一轮聚合，**立即返回 202 `{started:true}`**（不等跑完）；进度与结果看 /health 的 `lastRefreshAt` / `lastStats`。需请求头 `X-Refresh-Key: <REFRESH_KEY>`；未配置该 secret 时端点禁用（403），密钥不对 401。 |
| `GET /` | 服务名与端点一览。 |

## 与 App 的对接契约

`GET /calendar?date=...` 返回的快照结构：

```json
{
  "date": "2026-11-10",
  "generatedAt": "2026-11-10T01:03:27.426Z",
  "counts": { "entries": 200, "tmdbNamed": 96, "akaNamed": 30 },
  "entries": [ /* 见下表 */ ]
}
```

条目字段（与 App `CalendarEntry` 对齐）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `showTitle` | string | 剧名（已补名：TMDB 中文名 → akas 中文名 → TVmaze 原名） |
| `coverUrl` | string \| null | TVmaze 海报 |
| `tmdbCoverUrl` | string（可选） | TMDB 海报 URL，解析到 TMDB 条目时才有，客户端可优先用 |
| `airDate` | string | ISO 8601 播出时刻（有 airstamp 用原值，否则日期 +08:00 零点） |
| `hasTime` | boolean | 是否有确切播出时刻（Bangumi 条目恒 false） |
| `season` / `episode` | number \| null | 季 / 集号（Bangumi 条目为 null） |
| `episodeTitle` | string \| null | 集标题（`Episode N` 占位名已滤为 null；Bangumi 恒为「动画周更」） |
| `network` | string \| null | 电视网 / 播出平台名 |
| `source` | string | `tvmaze-schedule` \| `bangumi` |
| `popularity` | number | Bangumi 人气（votes+doing）；排期条目为 0 |
| `overview` | string \| null | 本集简介（TVmaze 集 summary 剥 HTML，无则剧级 summary） |
| `tmdbOverview` | string（可选） | TMDB show 级 zh 简介，解析到 TMDB 条目时才有 |

客户端约定：优先用后端快照；在追打标/个人条目在本地合并；
后端 404/不可达时回落现有客户端多源直拉，功能不缺位。
App 在「设置 → 账号 → 追剧日历后端」填入本服务地址后启用，未填则纯客户端直拉（无内置默认地址）。

## 部署（Cloudflare 控制台，全程网页操作）

> 不用在本地装任何东西：建 Worker、粘代码、绑 KV、填密钥、设定时，
> 全部在 Cloudflare 网页控制台完成。下面每一步的名字都按控制台界面写，
> 照着点即可。全部做完约 10 分钟。
>
> 准备好两样东西再开始：① 本目录 `src/index.js` 的全文（复制用）；
> ② TMDB 只读访问令牌（见第 4 步的获取路径，也可以先跳过、部署完再补）。

### 第 1 步：建 KV 命名空间

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com)，左侧进
   **Workers & Pages**（新版界面在「计算 / Compute」下）。
2. 找到 **KV**（在 Workers & Pages 页面里，或左侧「存储与数据库 /
   Storage & Databases → KV」）。
3. 点 **Create namespace**，名字填 `hbcalendar-cache`，创建。

### 第 2 步：建 Worker 并粘贴代码

1. 回到 **Workers & Pages**，点 **Create（创建）** → 选 **Create Worker**
   （或「从 Hello World 开始」一类入口）。
2. 名字填 `hbcalendar`（这就是之后地址的一部分，先占住），点 **Deploy**
   先把默认示例部署上去。
3. 部署完进这个 Worker 的详情页，点 **Edit code（编辑代码）** 打开网页编辑器。
4. 把编辑器里默认代码**全选删掉**，把 `src/index.js` 的全文粘贴进去，
   点右上角 **Deploy**。

### 第 3 步：给 Worker 绑上 KV（变量名必须叫 CACHE）

1. Worker 详情页 → **Settings（设置）** → 找 **Bindings（绑定）** 一节 →
   **Add（添加）** → 选 **KV namespace**。
2. **Variable name（变量名）填 `CACHE`**——必须一字不差，代码里就按
   这个名字读 KV，填错了等于没绑（症状：/health 里各天条数恒为空、
   /calendar 恒 404）。
3. KV namespace 下拉选第 1 步建的 `hbcalendar-cache`，保存；界面若提示
   部署新版本，点 **Deploy** 让它生效。

### 第 4 步：填两个密钥（Secrets）

还在 **Settings** 里，找 **Variables and Secrets（变量与机密）** → **Add**，
逐条加下面两个，类型都选 **Secret（机密）**，加完同样点 **Deploy** 生效：

| 名称 | 值填什么 | 说明 |
|---|---|---|
| `TMDB_TOKEN` | TMDB「只读访问令牌」 | 核心命名能力靠它。获取：登录 themoviedb.org → 头像菜单 **Settings → API** → 复制 **API Read Access Token (v4)**（一长串、以 `eyJ` 开头；**不要**用 32 位的 API Key）。可以先不填——不填也能部署运行，只是命名只剩别名兜底、/health 里 `tmdbConfigured` 显示 `false`，之后随时回来补填。 |
| `REFRESH_KEY` | 自己生成的一串随机值 | 手动刷新端点 `/refresh` 的钥匙。自己编一串 24 位以上的随机字母数字（或用密码管理器生成），**记好、别外传**。不填则 /refresh 禁用（不影响定时自动刷新）。 |

### 第 5 步：设定时任务（Cron）

1. **Settings** → 找 **Triggers（触发器）** 一节 → 里面的
   **Cron Triggers** → **Add Cron Trigger**。
2. 表达式填 `*/30 * * * *`（每 30 分钟一轮），保存。

### 第 6 步：记下地址并验收

Worker 详情页顶部会显示地址，形如：

```
https://hbcalendar.<你的子域>.workers.dev
```

下面记作 `$BASE`，验收三步（都不用装任何工具）：

1. **健康检查**：浏览器直接打开 `$BASE/health`，应看到一段 JSON：
   `ok: true`、`tmdbConfigured: true`（填了令牌的话）。`lastRefreshAt`
   刚部署完可能为空，等第 2 步触发一次即可。
2. **手动触发一轮聚合**（不等 cron 的 30 分钟）：用 Windows 自带的
   PowerShell（系统自带，不用装）执行下面一行——它会**立即**返回
   `{"started":true,...}`，聚合在后台跑，不用守着等：

   ```powershell
   curl.exe -X POST -H "X-Refresh-Key: 你的REFRESH_KEY" https://hbcalendar.<你的子域>.workers.dev/refresh
   ```

   然后等约 1 分钟，刷新第 1 步的 /health：`lastRefreshAt` 出现了时间、
   `days` 里有各天条数，就说明第一版成品已经生成。再看 `lastStats`：
   配了令牌的话 `tmdbNamed` 应大于 0；`remainUnresolved` 是还没解析到
   的剧数，会随之后每轮自动递减。

3. **看成品**：浏览器打开 `$BASE/calendar?date=今天日期`（如
   `?date=2026-11-10`），返回的 JSON 里应能看到中文剧名
   （吞噬星空、尚公主这类），说明整条链通了。此后 cron 每 30 分钟
   自动刷新，/health 的 `lastRefreshAt` 会持续更新。

### 常见问题

- **/calendar 一直 404、/health 里没有各天条数**：多半是第 3 步 KV
  没绑上或变量名不是 `CACHE`，回去核对绑定并重新 Deploy。
- **/health 里 tmdbConfigured 是 false**：第 4 步的 `TMDB_TOKEN`
  没填或填完没点 Deploy；补填后手动 /refresh 一轮即可。
- **tmdbNamed 一直是 0**：令牌填错了——确认填的是「只读访问令牌」
  （eyJ 开头的长串）而不是 API Key。
- **某部剧 TMDB 明明有中文名却一直没匹配上**：先开
  `$BASE/resolve?tvmaze=<该剧的 TVmaze id>` 看实时解析轨迹（TVmaze id
  在 tvmaze.com 该剧页面的 URL 里，如 …/shows/90035/…）。轨迹 steps 里
  出现 `kind: 'failed'`（429/超时/5xx）是**瞬时失败**——v3 起这类结果
  不落盘、每轮 cron 自动重试，一般等几轮就自愈，不用管；若全程都是
  `ok`/`notfound` 却仍没中文名，才是 TMDB 真没这部剧的中文资料（或
  TVmaze 的 externals 对不上），只能等资料补齐、或靠 aka 兜底（限国产）。
- **刚部署完名字是英文、或只有一部分是中文**：正常现象，不用管。
  补名单轮有时间上限（约 50 秒），名字按轮逐批解析、逐个存进缓存：
  每 30 分钟 cron 自动推进一轮，/health 的 `lastStats.remainUnresolved`
  会逐轮递减，几轮后补齐（第一版快照刚生成时名字先用原名顶着，
  数据本身是全的）。想加速可以连着手动 /refresh 几次，每次都接着
  上一轮的缓存往下解析。
- **更新代码**（以后从 GitHub 拿到新版 `src/index.js` 时）：Worker →
  Edit code → 全选替换粘贴 → Deploy，就这一处，不用重绑 KV 和密钥。
- **（可选）绑自定义域名**：Settings → **Domains & Routes** →
  Add → Custom Domain，填一个已托管在你 Cloudflare 账号下的域名。
  国内网络访问 workers.dev 偶有波动，自有域名通常更稳；
  App 对接时把后端地址换成该域名即可。

---

## 自托管（Docker）

> Cloudflare 免费版有两道硬限：每次运行最多 50 次子请求、KV 每天
> 最多写 1000 次，聚合这种「一轮几百次外部请求 + 大量写缓存」的活
> 在免费版上收敛不动。自有服务器跑 Docker 版则没有这些限制：聚合
> 逻辑与 Worker 版**共用同一份 `src/index.js`**（解析语义完全一致），
> 只是换了运行外壳 `server.mjs`（Node HTTP 服务 + 文件存储 + 内置
> 每 30 分钟调度），且单轮时间盒放长到 10 分钟、TMDB 节流放宽到
> 100ms。端点与返回结构两版一致，App 那边只是把后端地址换成
> 自托管域名即可。

### 前置条件

- 一台装了 Docker（含 compose 插件）的服务器，能被外网访问；
- 一个域名，把它的 A/AAAA 记录解析到这台服务器（Caddy 靠它自动
  签发 HTTPS 证书）；`Caddyfile` 里写的就是这个域名。

### 部署（五步）

镜像由 GitHub Actions 构建并发布在 GHCR
（`ghcr.io/binhe-cpu/hbcalendar`，amd64 + arm64 双架构，甲骨文等
ARM 机器可直接用），部署方**只拉镜像、不本地构建**：

```bash
# 1) 取部署文件：浅克隆本仓库，或者只下载这三个文件放同一目录
git clone --depth 1 https://github.com/binhe-cpu/hbcalendar.git
cd hbcalendar

# 2) 准备密钥：复制模板后填两个值（TMDB 只读访问令牌 + 自设的刷新密钥）
cp .env.example .env
vi .env

# 3) 如域名不是 hbplayer.hbyun.eu.org，改 Caddyfile 第一行
vi Caddyfile

# 4) 预建数据目录并改属主（重要）：./data 会 bind 挂载进容器，应用在
#    容器内以 uid 1000 运行；若目录不存在，Docker 会以 root 身份自动
#    创建（root:root 755），容器里写不进去，聚合会「跑通但存不下」、
#    /health 一直是空的——先建好并 chown 可免此坑
mkdir -p data && sudo chown 1000:1000 data

# 5) 拉镜像并启动（app 服务 + Caddy 反向代理）
docker compose pull && docker compose up -d
```

启动后 app 会在 5 秒内先跑一轮聚合，之后每 30 分钟一轮。验收：

```bash
curl https://<你的域名>/health        # lastStats 有 7 天数据即正常
curl "https://<你的域名>/calendar?date=<今天日期>"
```

### 更新方式

```bash
docker compose pull && docker compose up -d
```

新版本镜像发布后，拉下来重启即生效。已聚合的数据在 `./data`
目录里（一个 key 一个文件），换镜像/迁移都不丢，备份直接打包
这个目录即可。若改了代码想自构建：在 `docker-compose.yml` 里
注释掉 app 的 `image:` 行、放开 `build: .` 注释，再
`docker compose up -d --build`。

## 附录：用 wrangler 命令行部署（备选，与控制台等价）

本机装 Node.js ≥ 18 后，在本目录执行：

```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create hbcalendar-cache   # 把输出 id 回填 wrangler.toml 的 [[kv_namespaces]] 段
wrangler secret put TMDB_TOKEN                  # 粘贴只读访问令牌
wrangler secret put REFRESH_KEY                 # 粘贴自备随机串
wrangler deploy
```

验收命令与控制台路线相同（curl 换成终端版即可）。

## 本地开发 / 实测

```bash
node scripts/local_run.mjs                    # 内存 KV 桩 + 真网络跑一轮聚合
TMDB_TOKEN=<只读访问令牌> node scripts/local_run.mjs   # 连 TMDB 步一起验
npm run test:local                            # 同上
node scripts/test_timebox.mjs                 # 时间盒回归：TMDB 打桩固定慢 30s，断言 aggregate 限时返回且快照已落盘
node scripts/test_resolve.mjs                 # 瞬时失败不落盘回归（v3）：TMDB 打桩全程 429 断言 transient 不落盘；全程有结论断言负结果正常落盘
node scripts/test_putbudget.mjs               # put 预算回归（v6）：计数 KV 桩断言追赶轮 put ≤30、稳态轮 ≤17、整表各 ≤2 次
```

本机实测记录见 [LOCAL_TEST.md](LOCAL_TEST.md)（无令牌口径：
7 天 1194 条、点名国产剧全中、吞噬星空为中文名非拼音）。

## 运维备忘

- **KV 键一览**：`day:YYYY-MM-DD`（成品快照）、
  `names:v2`（v6 补名整表：`{tvmazeId: 结论}` 一键存全部 show，
  条目自带 exp——正负结论均 7 天，查空的 show 最迟 7 天后会被 cron
  重试、新剧中文资料补齐后能自愈；TMDB 瞬时失败的结果标 transient、
  根本不入表。v7 起由 `names:v1` 换代：v1 存量含同名异剧错配出的
  假 tmdbId 结论，整体作废，升级后首轮全量重查；v1 键不再读写）、
  `eps:v1`（v6 集解析整表：`{epKey: {name, overview, exp}}`，
  正结果 exp 30 天、负结果 exp 7 天）、
  `bangumi:YYYY-MM-DD`（Bangumi 周表日缓存，TTL 24h）、
  `meta:lastRefresh`（最近一轮统计，/health 读它）、
  `meta:diag`（最近一轮诊断状态，v5-diag，/health 的 diag 字段读它）。
  旧键 `showname2:{tvmazeId}`（v3–v5-diag 补名逐条键）与
  `ep:{tmdbId}:{s}:{e}`（v4–v5-diag 集解析逐条键）v6 起已弃用：
  新代码不再读写、不主动删除，靠各自 TTL 自然过期。
- **时区口径**：「未来 7 天」按 Asia/Shanghai 的今天起算。
- **失败行为**：单源失败只降级该源（某天排期拉空就少那份、
  Bangumi 失败当日无动画条目、TMDB 失败该 show 走 akas/原名），
  整轮不会因此中断；快照只覆盖成功生成的日期。
- **额度**：cron 每 30 分钟一轮。**写预算（v6）**：KV 免费套餐每日
  put 上限 1000 次（旧版每轮 150–250 次、2026-11-10 已被官方通知
  超限），v6 整表化 + 检查点收敛 + 快照跳写 + diag 刷盘节流后，
  稳态轮 ≤ 约 17 次 put、追赶轮 ≤ 约 30 次，全天 ≤ 约 850 次，
  由 scripts/test_putbudget.mjs 计数桩实测守护（实测稳态 6 次、
  追赶 23 次）。
