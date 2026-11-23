# GTA Transit Live：SEO 指南 MVP

本次交付是在现有实时地图旁增加公开的交通指南、成人单次票价计算器和中英文内容。本文说明实现和部署方法；源码和本地构建完成，不表示 Render 生产服务已经更新。实际发布状态应以关联 PR 和 Render 部署记录为准。本次实现没有连接或导入生产 PostgreSQL 数据库。

## 1. 架构与边界

| 部分 | 实现 | 运行方式 |
| --- | --- | --- |
| 公开指南 | Next.js App Router、TypeScript、Tailwind CSS，源码在 `web/` | 构建时生成完整 HTML、CSS 和少量交互 JavaScript，输出到 `web/out/` |
| 生产 HTTP 服务 | 现有 Node.js 原生服务 `server/index.js` | 继续使用一个 Node 进程；不额外启动 Next.js 生产服务器 |
| 公共页面路由 | `server/seo-guide.js` | `SEO_GUIDE=1` 时，允许名单内的公开 GET/HEAD 请求在账号鉴权之前处理 |
| 实时地图 | 原有 `public/` 和 `server/` | `/live` 进入原来的地图、账号、收藏、提醒及受保护 API |
| 票价模型 | `web/lib/fares.ts` | 无网络的确定性计算；浏览器输入变化后重新计算，页面初始内容已预渲染 |
| 可选静态时刻数据库 | PostgreSQL、`db/`、`scripts/gtfs/` | 管理员显式运行迁移和导入；不会在乘客访问页面时下载 GTFS |
| 数据来源状态 | 可选 `web/generated/feed-status.json` | 从数据库导出公开状态，再构建页面；没有快照时显示未载入 |

选择静态导出是为了让搜索引擎和不执行 JavaScript 的客户端直接读取实质内容，同时保留现有地图的部署方式及运行内存。修改内容、票价、canonical 域名或数据状态后，需要重新构建并部署；生产页面不会自动读取最新数据库快照。

原有账号、收藏、反馈和推送仍使用现有存储。新增 PostgreSQL 模块不迁移这些资料，也不在每次请求上增加 Upstash 读写。

## 2. 页面结构：13 个主题，26 个可索引 URL

英文为主语言，简体中文使用 `/zh` 前缀。每个语言版本独立 canonical，并互相声明 `hreflang`。

| 内容 | 英文 URL | 中文 URL |
| --- | --- | --- |
| 首页 | `/` | `/zh` |
| 成人单次票价计算器 | `/fare-calculator` | `/zh/fare-calculator` |
| Ontario One Fare | `/one-fare` | `/zh/one-fare` |
| 交通机构目录 | `/operators` | `/zh/operators` |
| TTC 指南 | `/operators/ttc` | `/zh/operators/ttc` |
| MiWay 指南 | `/operators/miway` | `/zh/operators/miway` |
| GO Transit 指南 | `/operators/go-transit` | `/zh/operators/go-transit` |
| 出行指南目录 | `/routes` | `/zh/routes` |
| Square One 至 Union Station | `/routes/square-one-to-union-station` | `/zh/routes/square-one-to-union-station` |
| Pearson 至 Union Station | `/routes/pearson-to-union-station` | `/zh/routes/pearson-to-union-station` |
| Kipling 至 Square One | `/routes/kipling-to-square-one` | `/zh/routes/kipling-to-square-one` |
| 数据来源与更新状态 | `/sources` | `/zh/sources` |
| 隐私说明 | `/privacy` | `/zh/privacy` |

出行页面复用模板，但仅生成已核实的三个目的地组合。没有任意站点排列组合、自动扩张的查询 URL 或重复线路页面。未知指南路径返回真正的 HTTP 404 和 `noindex`。

### 已实现的 SEO 输出

- 构建产物包含唯一标题、描述、单个 H1 和可直接阅读的正文。
- 每个页面包含 canonical、英文/中文互相对应的语言链接，以及 `x-default`。
- `/sitemap.xml` 仅列出上述 26 个页面；不包含登录、地图、API 或查询参数 URL。
- `/robots.txt` 声明 sitemap，并排除受保护的地图、账号和 API 路径。
- 正文有面包屑及内部链接；JSON-LD 包含 `WebSite`、`WebPage` 和适用的 `BreadcrumbList`。
- 使用系统字体、静态资源和有限的客户端组件；页面不依赖地图或实时接口加载完成才能显示。
- `GOOGLE_SITE_VERIFICATION` 可在构建时加入 Search Console HTML 验证标签；配置标签不等于已经完成所有权验证或提交 sitemap。

抓取、收录、排名及真实用户的 Core Web Vitals 仍需在部署后通过 Search Console 和真实访问监测。代码实现和测试结果不构成排名保证。

## 3. 鉴权、PWA 和兼容性

公开路由只读取构建目录中的明确页面和资源。`/api/*`、`/admin`、账号资料和 `/live` 继续经过原有鉴权；公开指南不访问用户存储。机器人与普通访客获得同样的内容，不做按 User-Agent 绕过登录的处理。

`/live` 在 `SEO_GUIDE=0` 时也保留，因此关闭指南不会破坏新安装 PWA 的入口。开启指南时，登录及注册成功跳转到 `/live`；关闭时保持原来的 `/` 跳转。私有页面附带 `X-Robots-Tag: noindex`。

兼容行为：

- 原来的 `/?stop=…`、`/?tab=…`、`/?ref=…` 在指南开启时转到 `/live` 并保留查询参数。
- PWA manifest 的 `start_url` 变为 `/live`。已经安装、仍保留根路径启动地址的 PWA，由首页的 `LegacyLaunch` 在 standalone 模式下转入地图。
- Service worker v23 只缓存地图外壳，不拦截公开指南、Next.js/RSC、账号或 API 请求；不会把登录重定向缓存成地图。
- 旧通知和通用提醒中的根路径 URL 转到 `/live`，保留站点、收藏等参数。
- 地图状态页在指南开启时显示“公交指南与票价计算”入口。

这些调整保留现有身份验证方式，并未将实时 API 变成匿名公开接口。若原服务没有设置访问密码，仍遵循原服务的本地开放行为。

## 4. 本地运行、构建与验证

使用 Node.js 24 与 npm。`.env.example` 是配置说明；原生 Node 启动命令不会自动加载该文件。通过 shell 或部署平台设置环境变量，不要提交填写了密钥的配置文件。

```bash
npm ci --include=dev
npm run dev
```

默认开发地址为 `http://127.0.0.1:3000`。该命令只启动 Next.js 指南开发预览；要验证 `/live`、原账号和原 API 的完整集成，请构建后使用原生服务器：

```bash
npm run build
SEO_GUIDE=1 npm start
```

完整集成默认地址为 `http://127.0.0.1:8821`。它会按现有逻辑在后台载入交通数据；公开指南自身不需要 PostgreSQL 或实时数据才能显示。若设置 `APP_PASSWORD` 或原有账号模式配置，地图仍需登录。

验证命令：

```bash
npm run typecheck
npm run test:guide
npm run build
npm run verify:guide
npm test
```

`test:guide` 覆盖票价计算与内容逻辑。`verify:guide` 检查实际构建的 HTML、canonical、语言链接、结构化数据、sitemap 和公开内容。`npm test` 包含原有账号、推送、反馈测试，以及新路由、PWA 和 GTFS 测试。构建产物检查必须在 build 后运行；数据库集成测试另需测试数据库或隔离的 PGlite 环境，详见 [数据库说明](../db/README.md)。

`.github/workflows/seo-guide-ci.yml` 在 PR 和 `main` 提交上执行这些检查，并启动独立的 PostgreSQL 16 测试服务，验证真实数据库导入、替换和失败回滚。该工作流没有部署步骤，不使用生产密钥；执行结果以 GitHub Actions 记录为准。

### 配置

| 变量 | 默认或示例 | 用途 |
| --- | --- | --- |
| `SEO_GUIDE` | 未设置/`0`：关闭；`1`：开启 | 生产公开路由的开关 |
| `SITE_URL` | `https://gta-transit-live.onrender.com` | 构建时的 canonical、sitemap 和语言链接域名，必须是无路径的 origin |
| `NEXT_TELEMETRY_DISABLED` | `1` | 关闭 Next.js 构建/开发遥测 |
| `GOOGLE_SITE_VERIFICATION` | 可选 | 构建时 Search Console 验证标签 |
| `DATABASE_URL` | 可选，无默认数据库 | 仅用于显式数据库迁移、导入和公开状态导出 |
| `GTFS_STATUS_FILE` | 可选绝对路径 | 指定构建时读取的状态快照；默认使用 `web/generated/feed-status.json` |

如果使用自定义域名，先设置正确的 `SITE_URL`，再重建；只修改运行环境而不重建不会改变已经输出的 metadata。

## 5. Render 部署与回滚

仓库中的 `render.yaml` 已声明新的构建流程：

```text
Build Command: npm ci --include=dev && npm run build:render && npm run prefetch
Start Command: node server/index.js
Health Check: /healthz
```

`build:render` 将 Next.js 构建的 V8 堆上限单独设为 384 MB；现有服务器仍保留 `NODE_OPTIONS=--max-old-space-size=256`，原时刻表预取命令使用其原来的 200 MB 上限。V8 堆上限不等于进程总内存；必须以 Render 实际构建日志和实例资源为准。

Blueprint 声明 `SEO_GUIDE=1`、生产 `SITE_URL` 和 `NEXT_TELEMETRY_DISABLED=1`。**本地和代码默认仍关闭公开指南**；只有运行环境明确开启才生效。

对于已经在 Render Dashboard 手工创建或调整过的服务，不能假设修改仓库 YAML 会自动更新实际 Build Command 或环境变量。部署前应核对该服务的配置是否由 Blueprint 管理；若为手工配置，分别更新构建命令和上述变量，同时保留当前账号、Redis、GO API、VAPID 和提醒密钥。无需新建另一份地图服务。

开启标志必须与已成功生成的 `web/out` 一起部署。若旧服务仍只执行 `npm ci && npm run prefetch`，则没有构建指南；此时应先更新 Build Command，不能直接开启标志。启动检查会在缺少 `index.html`、`robots.txt` 或 `sitemap.xml` 时明确失败，避免把半成品误当成已上线。

部署后最低验收：

1. 匿名访问 `/`、`/zh`、`/fare-calculator`、`/sources`、`/robots.txt`、`/sitemap.xml`。
2. 确认 `/live` 仍需要既有登录，匿名 API 请求仍被拒绝。
3. 确认登录、收藏、提醒及已安装 PWA 入口正常。
4. 确认 sitemap 和 canonical 使用生产域名，再在 Search Console 验证所有权并提交 sitemap。

快速回滚：将 `SEO_GUIDE` 改为 `0` 或移除该变量，重启服务。根路径恢复旧地图流程，`/live` 别名继续可用。无需删除数据库、清空 Redis、修改密码或重新生成推送密钥。此处指**功能开关回滚**；若回退到完全不含 `/live` 别名的历史提交，还需单独处理已安装 PWA 的新入口兼容性。

## 6. PostgreSQL / GTFS 接入

新增迁移与导入器已实现，但没有自动创建生产 PostgreSQL，也没有把演示数据伪装成已导入的正式时刻表。公开指南可在没有数据库的情况下工作；`/sources` 会如实标记未载入。

准备由你管理的 PostgreSQL 14+ 数据库，并安全设置 `DATABASE_URL` 后，可执行：

```bash
npm run db:migrate
npm run gtfs:import -- --agency miway --download
npm run gtfs:import -- --agency ttc --download
npm run gtfs:import -- --agency go --download
npm run gtfs:status
npm run build
```

需要部署最后生成的构建结果，公开页面才显示新的状态快照。导入成功不会自动触发线上重建。也可使用 `--file /absolute/path/feed.zip` 导入经过确认的本地文件；本地文件不冒充官方刚下载的文件。

数据模型包括机构、版本化 feed、线路、站点、行程、站序时刻、服务日历、日期例外和独立的实时观测边界。导入过程验证文件、字段和引用关系，使用事务与每机构锁，在完整成功后才切换 `active_feed_id`；失败保留上一有效版本。

分别记录来源 URL、许可、署名、下载时间、发布方更新时间、导入时间、有效服务日期和哈希。GTFS 中超过 `24:00:00` 的时间保留为服务日秒数。数据不会自动变成跨城路线规划器，也不会被标作实时预测。

详细命令、数据库测试、保留策略与导入范围见 [数据库说明](../db/README.md)。官方票价、One Fare、GTFS 链接和许可依据见 [来源核实记录](official-sources.md)。

## 7. MVP 的明确范围

- 票价工具支持成人、最多两个不同机构的一次旅程；不计算年龄优惠、月/周封顶、月票、所有特殊纸质换乘或三段以上行程。
- TTC 与 MiWay 区分 PRESTO、银行卡和现金。GO 需要用户输入官方行程报价；没有报价不生成总价。结果为规则估算，不是售票或扣款承诺。
- 120/180 分钟的到期瞬间采用保守处理；页面说明相关边界和同一张卡/设备要求。
- 三篇路线指南只提供经过核实的换乘说明与官方规划入口，不生成未经验证的车次、到站时间、平台或总时长。
- 新数据库中的实时观测表只是未来适配边界。原地图已有实时模块继续独立运行，新增静态导入并不等于完成新的实时接入。
- TTC SurfaceGTFS 与 BusTime 需匹配标识，不能宣传为完整地铁覆盖；GO 的受控 API 仍使用原来的授权配置。
- 尚未安排定期数据库导入、状态导出或网站重建。定期任务应在真实数据库、数据许可和运行资源确认后配置。
- 尚未提交 Search Console、获得自然流量或测出线上 CWV；这些需要实际发布和后续访问数据。

不要把内容核实日期替换成每天的新日期以制造“更新”信号。只有价格、服务信息、页面内容或来源被实际检查和修改后，才更新相应的审核记录和页面修改日期。
