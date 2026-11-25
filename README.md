# immich-cf

immich-cf 是基于 Cloudflare Workers、D1 和 R2 的 Immich 兼容服务端验证项目，可连接官方 Immich App，并提供中文网页图库。[项目文档](docs/README.md)

## 从 GitHub 部署到自己的 Cloudflare 账号

**套餐条件。** 项目现有的 bcrypt 密码登录在实测中超过 Workers Free 的 CPU 额度。项目既有部署使用 Workers Paid。请在部署前确认自己的套餐能承载登录请求。[登录 CPU 实测](docs/p2-auth-sync-cpu.md) · [套餐记录](docs/paid-development-decision.md)

1. 在 GitHub 打开本仓库，点击 **Fork → Create fork**，确认自己的仓库有 `main` 分支。
2. 在 Cloudflare 控制台进入 **Storage & databases → R2 → Overview**。首次使用 R2 时，按页面提示开通服务。R2 按账户用量计费。[R2 开通说明](https://developers.cloudflare.com/r2/get-started/)
3. 进入 **Workers & Pages → Create application**，选择从 Git 仓库导入 **Worker**。连接 GitHub，授权读取刚才的 Fork，选中该仓库，然后填写下表。[Workers Builds 设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

| 控制台设置                            | 填写内容                                             |
| ------------------------------------- | ---------------------------------------------------- |
| Worker 名称                           | `immich-cf`                                          |
| 生产分支                              | `main`                                               |
| 根目录                                | 保留仓库根目录                                       |
| 构建命令（Build command）             | `pnpm web:build`                                     |
| 部署命令（Deploy command）            | `pnpm deploy:selfhost`                               |
| 非生产分支构建（Preview builds）      | 关闭                                                 |
| 构建变量 `INITIAL_ADMIN_EMAIL`        | 用于登录图库的管理员邮箱                             |
| 加密构建密钥 `INITIAL_ADMIN_PASSWORD` | 自设初始密码，至少 15 个字符，UTF-8 编码最多 72 字节 |

4. 在 **Build variables and secrets** 添加上表的邮箱和密码，把密码标记为 **Secret**。在 **Build → API token** 选择当前账号的构建令牌。Cloudflare 默认创建的令牌已有 Workers Scripts 和 Workers R2 Storage 编辑权限，还需在 **My Profile → API Tokens** 为该令牌补上 **Account → D1 → Edit**。如果首次部署已开始，可在补齐权限后打开该次构建并点击 **Retry build**。[构建令牌权限](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)
5. 点击 **Deploy**。首次部署会创建或复用账号内专用于本实例的 `immich-cf-selfhost-db` 和 `immich-cf-selfhost-media`，应用 D1 迁移，并在空用户库中创建管理员。请为该实例预留这两个名称，并保持媒体桶私有。部署成功后，打开控制台显示的 `workers.dev` 地址，用上表的邮箱和密码登录。从“账号管理”可创建普通用户。官方 App 的服务器地址也填这个根地址。

**更新与改密。** 首次登录后，可在图库“账号设置”修改密码，并从 Cloudflare 构建设置移除两个初始凭据。以后在 GitHub Fork 的 `main` 页面点击 **Sync fork → Update branch**，或向自己的 `main` 推送提交，Cloudflare 即会自动部署。更新会复用数据库和私有桶，只应用待执行的迁移，保留已有密码和照片。构建失败时按日志修正设置，再点击 **Retry build**。

**照片预览。** 默认可上传和下载原件。生成缩略图还需 Cloudflare Images 转换额度。请先在自己的账号中确认 Images 可用并了解计费，再在 **Build variables and secrets** 增加普通变量 `IMAGES_FREE_CONFIRMED=true` 并重新部署。部署会将该开关传给 Worker，已有的 `IMAGES` 绑定和每 5 分钟运行的维护任务会处理待生成的预览。[Images 绑定](https://developers.cloudflare.com/images/transform-images/bindings/)

## 维护者发布

维护者按 `dev → test → main` 晋升代码。生产命令 `pnpm deploy:prod` 从 `main` 分支发布到现有的 `prod` 环境。本地安装 Node.js 24（至少 24.9.0）与 pnpm 11.25.0 后运行 `pnpm install --frozen-lockfile`。在对应分支的干净工作区运行 `pnpm release:dev`、`pnpm deploy:test` 或 `pnpm deploy:prod`。授权、验收和 GitHub Actions 手动发布步骤见[三环境开发与发布](docs/environments.md#逐级晋升)。
