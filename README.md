# GTA 公交实时

多伦多地区（GTA）公交全屏实时地图：车辆位置与晚点、附近站点、收藏站点、站点到站倒计时。可本地运行，也可部署到 Render。个人非官方项目。

## 启动

```bash
cd ~/Downloads/08_代码项目/GTA公交实时
npm start
```

打开 http://localhost:8821 （端口已在「端口登记」里登记）。

- 第一次启动会在后台下载各机构时刻表（TTC 约 66MB），1 分钟内完成；之后读本地缓存 `data/`，7 天自动更新一次。
- 页面每 20 秒刷新。
- 在国内时需要代理：`npm start` 会自动使用 shell 里的 `HTTPS_PROXY`（Node 的 `NODE_USE_ENV_PROXY=1`）。

## 界面

- 全屏地图。车辆圆标内是线路号，填充色是线路色，外圈是晚点分级（黑=提前，绿=准点/晚 0–2 分，黄=晚 3–4 分，红=晚 5 分以上，灰=无数据），小三角指向行驶方向。视野内超过 250 辆时改用小圆点。
- 车辆在两次刷新（20 秒）之间平滑移动；位移超过 1.5 公里或页面刚从后台回来时直接到位。
- 点一辆车（Livemap 式）：地图画出这趟车的线路走向，「车辆」标签列出剩余站点、预计时间和每站晚点；默认跟随，拖动地图退出，点「跟随」恢复；点站名跳到该站到站页。
- 右上「筛选」：按交通方式（铁路 / 地铁·电车 / 公交）；按线路开关（只列当前在跑的线路）；「缩小时只显示火车」；「放大后显示站点」（15 级以上）。
- 右下 ◎ 定位：显示你附近 800 米内的站点和每站下两班（需要 HTTPS 或 localhost）。拒绝定位时可用「用地图中心查附近」。
- 抽屉（手机在底部，可拖动；桌面在左侧）：路线 / 附近 / 收藏 / 到站 / 车辆 / 状态。
- 晚点来源：MiWay、YRT 来自 TripUpdates；GO 来自 ServiceataGlance；Brampton 源不带晚点（灰色）。

## 路线规划

- 「路线」标签：起终点可选「我的位置」「地图中心」、地名（Transitous 地理编码）或站点；可选出发/到达时间。
- 规划服务：[Transitous](https://transitous.org/api/)（MOTIS 2，社区免费服务）。条件：项目开源、非商业、`/plan` 每天少于 720 次。本项目默认每天最多 600 次（`PLANNER_DAILY_MAX`），`PLANNER=off` 可关闭。
- 结果叠加本地实时数据：每程显示实时上下车时间与晚点；换乘处判断「来得及（≥3 分）/ 紧张（0–3 分）/ 可能赶不上」，赶不上时给出同站同线下一班。
- 没有结果、额度用完或服务不可用时，改为「在 Google 地图里打开」。
- 数据来源署名：https://transitous.org/sources/ 与 OpenStreetMap。

## 到站推送提醒

- 到站页点「🔔 提醒我」：选线路（或任意）、提前几分钟、星期、时间段（多伦多时间）、是否只提醒一次。
- 「收藏」页顶部管理提醒，可发送测试通知。
- 需要：HTTPS（云端地址）；iPhone 先「添加到主屏幕」再从主屏打开（iOS 16.4+）；服务器配置 VAPID 密钥和 Upstash。
- 服务端每 30 秒检查一次正在生效的规则；同一班车只推一次。服务器休眠时不推送，所以云端要配保活 ping。
- 规则按设备保存（每台设备最多 10 条）。本地开发自动生成 `data/vapid.json`，存储用 `data/kv.json`。

## 云端部署（Render 免费版）

代码在私有仓库 `mrgreedcp-spec/gta-transit-live`，根目录有 `render.yaml`。

1. 用 GitHub 账号登录 https://render.com 。
2. Dashboard → New → Blueprint → 授权 Render 访问 `gta-transit-live` 仓库 → 选中它。
3. 弹框里填：`APP_PASSWORD`（访问密码，自己定）；`GO_API_KEY`（没有就留空）。
4. 点 Apply，等首次构建（约 3–6 分钟，构建时会预下载全部时刻表）。
5. 打开 `https://gta-transit-live.onrender.com`（以 Render 显示的地址为准），输入密码。

环境变量（Render → 服务 → Environment）：

| 变量 | 用途 | 必填 |
|---|---|---|
| `APP_PASSWORD` | 访问密码 | 建议 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 持久存储（推送提醒） | 推送需要 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push 密钥（`npx web-push generate-vapid-keys` 生成，固定不变） | 推送需要 |
| `GO_API_KEY` | GO 实时 | 可选 |
| `PLANNER` / `PLANNER_DAILY_MAX` / `PLANNER_CONTACT` | 规划服务开关、每日上限、User-Agent 联系方式 | 可选 |

保活：在 cron-job.org 或 UptimeRobot 建一个每 10 分钟访问 `https://<你的地址>/healthz` 的任务（推送提醒需要服务器醒着）。

说明：
- 免费版 15 分钟无访问会休眠，下次打开约 1 分钟唤醒，页面会显示「服务唤醒中」。
- 推送到 GitHub 的 main 分支会自动重新部署，同时刷新时刻表。云端时刻表有效期 30 天（`STATIC_MAX_AGE_DAYS`）。
- GO key 批下来后：Render → 服务 → Environment → 填 `GO_API_KEY` → Save（会自动重启）。
- iPhone 主屏 app 和 Safari 的登录状态分开，主屏 app 里要再登录一次；登录保持 180 天。改 `APP_PASSWORD` 会让所有人重新登录。
- 本地不设 `APP_PASSWORD` 时不需要登录。

## 手机使用（局域网，PWA）

1. Mac 上运行（手机和 Mac 连同一个 Wi-Fi）：

   ```bash
   npm run phone
   ```

   终端会打印手机地址，如 `http://<Mac的局域网IP>:8821`，或 `http://<Mac主机名>.local:8821`（IP 变了也能用）。第一次运行 macOS 可能弹窗问「允许 node 接受传入连接」，点允许。
2. iPhone 用 Safari 打开该地址 → 分享 → 「添加到主屏幕」。之后从主屏图标打开就是全屏 app。
   Android 用 Chrome 打开 → 菜单 → 「添加到主屏幕 / 安装应用」。
3. 收藏：搜站点 → 点到站表右上角 ☆ → 收藏区显示每站下两班。「编辑」可上下排序、删除。收藏存在手机本地。

注意：
- 手机要连到 Mac 上运行的服务。Mac 关机或 `npm run phone` 没开时，app 显示红色「连不上服务」。
- `npm run phone` 对同一网络的所有设备开放，公共 Wi-Fi 下不要用。`/api/go/raw/` 透传只允许本机访问。
- 收藏按地址分开存：换了访问地址（IP 变化、改用 Tailscale）收藏不会跟过去。建议固定用 `.local` 地址。
- 局域网 http 下没有离线缓存（service worker 需要 HTTPS）。想要 HTTPS + 在外面也能用：Mac 和手机都装 Tailscale 并登录，`npm start` 后运行 `tailscale serve --bg 8821`，手机用 Tailscale 给的 `https://…ts.net` 地址打开。
- 改了前端文件后，把 `public/sw.js` 里的 `VERSION` 加 1。

## 数据源

| 机构 | 实时 | key | 备注 |
|---|---|---|---|
| TTC | bustime.ttc.ca GTFS-RT | 不要 | 中国/日本出口连不通，疑似地区限制；在加拿大应可用 |
| GO Transit | OpenDataAPI（JSON） | **要，免费** | 无 key 时只显示站点和线路 |
| MiWay | miapp.ca GTFS-RT | 不要 | |
| Brampton | bt-cadavl.com GTFS-RT | 不要 | |
| YRT | rtu.york.ca GTFS-RT | 不要 | 官方要求先在 yrt.ca 填表接受数据许可 |
| Durham | drtonline GTFS-RT | 不要 | 常返回 502/403 |

关掉某个机构：改 `server/agencies.js` 里的 `enabled: false`。

## GO API key

1. 已于 2026-11-15 提交申请（https://api.openmetrolinx.com/OpenDataAPI/Help/Registration/en ），人工审批最长 10 个工作日，key 发到申请邮箱。
   协议要点：不能用 GO/Metrolinx 品牌、不能暗示官方、不能通过自己的公开 API 再分发 GO 数据。
2. 收到 key 后存进钥匙串（推荐）：

   ```bash
   security add-generic-password -s go-api-key -a "$USER" -w '你的KEY'
   ```

   或临时用环境变量：`GO_API_KEY=你的KEY npm start`
3. 重启。GO 列车/巴士会出现在地图上（含晚点、满载率），GO 站点可查实时发车，侧栏出现 Union 发车板和服务公告。

## API

| 端点 | 说明 |
|---|---|
| `/api/status` | 每个机构的静态/实时状态 |
| `/api/vehicles?agencies=miway,yrt&bbox=w,s,e,n` | 实时车辆（含 delaySec、routeColor、mode） |
| `/api/routes?agency=miway` | 线路表 |
| `/api/stops/search?q=square` | 站点搜索（站名或站号） |
| `/api/stops/near?lat=43.593&lon=-79.642&radius=800` | 附近站点（按距离） |
| `/api/stops/bbox?w=&s=&e=&n=&limit=300` | 视野内站点 |
| `/healthz` | 健康检查（不需登录） |
| `/api/plan?from=lat,lon&to=lat,lon&time=&arriveBy=1` | 路线规划（Transitous + 实时衔接） |
| `/api/geocode?q=` | 地名搜索 |
| `/api/push/key` `/api/push/subscribe` `/api/push/rules` `/api/push/test` | 推送提醒 |
| `/api/stops/<机构>/<stop_id>/arrivals` | 某站未来 90 分钟实时到站 |
| `/api/trip/<机构>/<trip_id>?veh=<车辆id>&route=<线路>` | 单趟车：线路走向（polyline 精度 5）+ 剩余站点（来自 TripUpdates） |
| `/api/arrivals?s=miway:0085&s=brampton:00045505&limit=2` | 批量到站（收藏列表用，最多 30 站） |
| `/api/go/union` `/api/go/alerts` | GO Union 发车 / 服务公告（需 key） |
| `/api/go/fares?from=UN&to=OA` | GO 票价（需 key） |
| `/api/go/raw/<官方V1路径>` | 透传任意 GO 官方接口（只限本机，云端禁用），如 `/api/go/raw/Schedule/Line/All/20261115` |

## 文件

- `server/agencies.js` 机构配置
- `server/realtime.js` GTFS-RT 拉取、解码、15 秒缓存、到站索引
- `server/static.js` 静态 GTFS 下载与解析（只读 routes/stops/trips）
- `server/go.js` GO OpenDataAPI
- `server/index.js` HTTP 服务（gzip、路由）
- `server/auth.js` 访问密码（APP_PASSWORD）
- `server/planner.js` 路线规划与换乘衔接
- `server/push.js` 推送提醒（Web Push + 定时检查）
- `server/kv.js` 存储（Upstash 或本地文件）
- `server/ratelimit.js` 限流
- `public/plan.js` `public/push.js` 路线与提醒前端
- `scripts/prefetch-static.js` 构建时预下载时刻表
- `render.yaml` Render 部署配置
- `public/` 前端（Leaflet）

Data used in this product or service is provided with the permission of Metrolinx.
