# GTA公交实时
- 栈：Node 24 原生 http（server/），前端纯 JS + Leaflet（public/），存储 Upstash Redis REST（server/kv.js，本地退回 data/kv.json）。部署：push main → Render 自动部署。
- 测试：`npm test`（node --test，web-push / kv 用 mock）。本地运行：`npm start`，端口 8821。
- 约定：前端改了就把 public/sw.js 的 VERSION 加 1；不读、不提交 data/vapid-render.txt 和任何密钥；鉴权相关新功能放在环境变量开关后，默认关闭。
- 目标：手机上流畅看 GTA 实时公交、收藏、到站提醒。非目标：商用、多租户运营后台。
- 审查规则见 ./REVIEW.md
