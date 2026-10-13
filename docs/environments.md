# dev → test → prod 开发与发布

更新：2026-10-14。开发使用 dev，验收环境统一命名 test（替代旧规划 staging），生产资源不加 prod 后缀。环境间只晋升代码和迁移，不复制用户、密码、会话或媒体。

## 客户端地址与资源

| 环境 | 客户端服务器地址                           | Worker / D1 / R2                                              | 当前状态                       |
| ---- | ------------------------------------------ | ------------------------------------------------------------- | ------------------------------ |
| dev  | https://immich-cf-api-dev.fun.workers.dev  | immich-cf-api-dev / immich-cf-db-dev / immich-cf-media-dev    | 已发布并开启 P1 入口           |
| test | https://immich-cf-api-test.fun.workers.dev | immich-cf-api-test / immich-cf-db-test / immich-cf-media-test | 规划地址；资源尚未创建、未发布 |
| prod | https://immich-cf-api.fun.workers.dev      | immich-cf-api / immich-cf-db / immich-cf-media                | 规划地址；资源尚未创建、未发布 |

官方 App 填写根地址即可，不需要自行加 `/api`。切换环境使用 App 现有服务器/账号入口；各环境分别登录，禁止复用 token。用户、图库、备份状态和同步检查点独立，首次切换后的本地缓存/重同步行为仍须 iOS 3.3.1 build 23 真机验收，不能把开发测试数据当作生产备份。

dev 测试邮箱为 `dev@immich-cf.test`，随机密码保存在本机忽略目录 `work/dev-access.txt`，不纳入 Git。当前仅有发现、登录、会话与空库 Sync；上传、媒体和完整 App 初始化未完成，不能用于正式备份。

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

GitHub `Promote environment` 工作流为手动触发，不因推送自动发布。仓库需配置 dev/test/prod GitHub Environments 及各自 `CLOUDFLARE_API_TOKEN` secret，test/prod 建议设置审核人；本次没有配置或获取这些 secrets，也没有推送分支。工作流 checkout 目标分支，跑完整检查后使用同一发布脚本。配置在本地提交不等于远程 CI 已启用。

test/prod 当前 `ENABLE_P1_POC=false`，不会随 dev 入口启用自动开放。待阶段验收后，明确修改对应环境开关并晋升；这些基础配置应在 dev 分支维护，确保三个分支可快进。

## 2026-10-14 部署与验证

使用 cloudflare-api 上传已 dry-run 构建的 dev Worker，deployment ID：`0872383e63144e33a16c4982e14e9ae0`。远程已存在 0001/0002 迁移，本次核对后复用，没有重复迁移或覆盖用户。

公网验证：health/discovery/ping 200，密码登录 201，Cookie users/me 200，Sync 200（AuthUserV2 + SyncCompleteV1），ACK 204，退出 200。只输出脱敏结果，随机密码和令牌不进入 Git；数据库仅保存密码哈希和会话令牌哈希。这是服务端协议冒烟，不等于官方 iOS 真机或 Free CPU 负载验收。

本地 `http://127.0.0.1:8787` 通过同一 dev 测试账户完成 health/discovery/ping 200、登录 201、users/me 200、Sync 200、ACK 204、退出 200，确认本机执行代码并使用远程 dev D1。R2 仍为私有，本次没有写入照片。test/prod 保留为待晋升环境，不承诺当前地址可登录。
