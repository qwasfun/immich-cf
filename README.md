# immich-cf

## 项目介绍

immich-cf 是基于 Cloudflare Workers、D1 和 R2 的 Immich 兼容服务端验证项目，目标是让官方 Immich App 无需修改即可连接，并提供中文网页图库。

[项目文档](docs/README.md)

## 部署方式

需要 Node.js 24（至少 24.9.0）、pnpm 11.25.0 和 Git。先安装锁定的依赖。

```sh
pnpm install --frozen-lockfile
```

使用 Wrangler 授权，按 dev → test → prod 逐级验收和晋升。在对应分支的干净工作区运行该环境的发布命令。发布脚本会构建网页、应用目标环境的 D1 迁移，再部署 Worker。

| 环境 | 发布命令           |
| ---- | ------------------ |
| dev  | `pnpm release:dev` |
| test | `pnpm deploy:test` |
| prod | `pnpm deploy:prod` |

授权、分支晋升及 GitHub Actions 手动发布见[三环境开发与发布](docs/environments.md#逐级晋升)。
