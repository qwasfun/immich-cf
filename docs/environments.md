# dev → test → prod 开发与发布

更新：2026-11-13。开发使用 dev，验收环境统一命名 test（替代旧规划 staging），生产资源不加 prod 后缀。环境间只晋升代码和迁移，不复制用户、密码、会话或媒体。

2026-11-13 dev 兼容协议已升级至官方 3.4.1，328 项完整检查和 45 项公网检查通过；test/prod 继续运行 3.3.1 协议版本，未随本次适配晋升。功能边界和实际版本见 [3.4.1 对齐记录](upstream-v3.4.1.md)。

## 客户端地址与资源

| 环境 | 客户端服务器地址                           | Worker / D1 / R2                                              | 当前状态                 |
| ---- | ------------------------------------------ | ------------------------------------------------------------- | ------------------------ |
| dev  | https://immich-cf-api-dev.fun.workers.dev  | immich-cf-api-dev / immich-cf-db-dev / immich-cf-media-dev    | 已发布并开启 P1 入口     |
| test | https://immich-cf-api-test.fun.workers.dev | immich-cf-api-test / immich-cf-db-test / immich-cf-media-test | 已发布，独立数据库与媒体 |
| prod | https://immich.185036.xyz                  | immich-cf-api / immich-cf-db / immich-cf-media                | 已发布，独立数据库与媒体 |

官方 App 填写根地址即可，不需要自行加 `/api`。切换环境使用 App 现有服务器/账号入口；各环境分别登录，禁止复用 token。用户、图库、备份状态和同步检查点独立，首次切换后的本地缓存/重同步行为仍须当前所用 App 真机验收（dev 升级目标为 3.4.1），不能把开发测试数据当作生产备份。

生产增加 `https://immich.185036.xyz`，原 `https://immich-cf-api.fun.workers.dev` 继续可用，两者访问同一生产 Worker、账号和图库。浏览器登录 Cookie 按主机隔离，首次访问新域名需重新登录。域名配置仅在 `env.prod.routes` 中维护；后续生产发布会保留该绑定，dev/test 不绑定此域名。绑定与证书、验证结果见[生产域名说明](prod-custom-domain.md)。

dev 测试邮箱为 `dev@immich-cf.test`，随机密码保存在本机忽略目录 `work/dev-access.txt`，不纳入 Git。现有功能包含网页图库、账号管理、JPEG/PNG/HEIC 上传与预览、Live Photo 配对和 Sync；完整真机、容量与灾备验收仍按阶段文档推进。test/prod 初始登录信息仅保存在本机忽略文件 `work/test-prod-initial-access.txt`。

2026-11-12 已将当前 Web 功能晋升至 test、prod，两套迁移均到 0038；部署版本、验收与清理结果见[本次晋升记录](test-prod-web-2026-11-12.md)。

## 本地调试

```sh
pnpm dev
```

代码在本机执行，默认地址 `http://127.0.0.1:8787`；D1/R2 绑定配置 `remote: true`，操作真实 dev 资源。**本地写入会影响公网 dev 客户端**。不指向 test/prod。公网 dev 地址执行最近发布的代码，本地热更新不会自动改变公网代码。

当前网络上 Node TLS 握手间歇发生 ECONNRESET；使用 TLS 1.2 并重启连接后，授权检查和本地远程绑定冒烟均通过；网络仍可能间歇失败。`scripts/dev.mjs` 提供进程级 TLS 1.2 兼容尝试，保留证书验证，不修改系统代理；这只是本机兼容措施，不能保证网络稳定性。网络恢复后可直接 `pnpm exec wrangler dev --env dev` 使用默认协商。Wrangler 需要本机授权；OAuth 或 API token 不进入仓库。

```sh
pnpm dev:local
pnpm db:migrate:local
```

以上用于离线隔离实验。`--local` 禁用远程绑定。自动化测试显式启用 forceLocal/remoteBindings=false，独立状态不使用 dev 数据；原骨架测试显式关闭 P1 开关。

官方依据：[远程绑定与本地模式](https://developers.cloudflare.com/workers/local-development/)。D1/R2 数据资源在配置层隔离，不依赖请求参数决定环境。

## 逐级晋升

使用同名 Git 分支 `dev`、`test`、`prod`。首次建立时共用环境配置基线，不代表同时向三个环境发布。`main` 保留既有历史；后续从 dev 开发。

1. 在 dev 开发、提交并运行 `pnpm check` 和 `pnpm contracts:verify`，发布到 dev 验证。
2. 先在 dev 分支配置 test 独立 D1/R2 的真实 ID 并提交、验证。dev 本阶段通过后，将已验收提交快进到 test：`git switch test`、`git merge --ff-only dev`；避免直接在 test 修改公共配置造成分叉。
3. test 验收通过后，`git switch prod`、`git merge --ff-only test`。生产独立资源配置同样先作为公共配置进入 dev/test，再晋升。
4. 发布前保持工作区干净；先检查、迁移目标环境，再部署。发布后记录 SHA、Worker 版本、迁移、健康/登录/同步验证。

```sh
pnpm release:dev
pnpm deploy:test
pnpm deploy:prod
```

发布脚本要求当前分支与目标一致；test 的 HEAD 必须已在 dev 历史中，prod 必须已在 test 历史中。未填写真实 D1 ID 时拒绝发布；不会替你自动合并、建资源或修改密码。临时回退不能擅自回滚数据库，迁移保持向后兼容，破坏性变更单独规划。

GitHub `Promote environment` 工作流为手动触发，不因推送自动发布。仓库需配置 dev/test/prod GitHub Environments 及各自 `CLOUDFLARE_API_TOKEN` secret，test/prod 建议设置审核人；本次通过已有本机 OAuth 和 CLI 发布，并已推送三个环境分支；没有新增或获取 deployment secrets。工作流 checkout 目标分支，跑完整检查后使用同一发布脚本。推送会运行 Checks；手动部署工作流仍依赖各环境的 secret 和 Environment 配置。

2026-11-10 首次晋升已显式为 test/prod 启用现有功能、Live Photo、Images 免费预览与每 5 分钟 Cron。基础配置继续在 dev 分支维护，确保三个分支可快进；资源、版本和验收边界见[测试与生产发布记录](test-prod-deployment.md)。

## 2026-10-14 部署与验证

使用 cloudflare-api 上传已 dry-run 构建的 dev Worker，deployment ID：`0872383e63144e33a16c4982e14e9ae0`。远程已存在 0001/0002 迁移，本次核对后复用，没有重复迁移或覆盖用户。

公网验证：health/discovery/ping 200，密码登录 201，Cookie users/me 200，Sync 200（AuthUserV2 + SyncCompleteV1），ACK 204，退出 200。只输出脱敏结果，随机密码和令牌不进入 Git；数据库仅保存密码哈希和会话令牌哈希。这是服务端协议冒烟，不等于官方 iOS 真机或 Free CPU 负载验收。

本地 `http://127.0.0.1:8787` 通过同一 dev 测试账户完成 health/discovery/ping 200、登录 201、users/me 200、Sync 200、ACK 204、退出 200，确认本机执行代码并使用远程 dev D1。R2 仍为私有，本次没有写入照片。test/prod 保留为待晋升环境，不承诺当前地址可登录。

## dev 持续调试授权（2026-10-30）

用户明确指定 dev 用于随时调试：后续按 dev 分支开发、完整本机检查、部署 dev、公网验证推进，无需对常规 dev 发布重复询问。使用既有代理和 curl 有界重试；间歇网络失败先按传输不稳定处理，不据此直接判业务缺陷。部署仍记录源码/Worker版本/迁移与脱敏结果，不改变 test/生产、密码安全性、媒体限制或 reset/ACK 隔离；故障注入与破坏性演练继续优先用隔离资源。
