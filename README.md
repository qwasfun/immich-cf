# immich-cf

基于 Cloudflare Workers / D1 / R2、以完全不修改官方 Immich App 为硬约束的兼容服务端验证项目。

当前处于**初始骨架阶段**：已提供 Worker、本地 D1/R2 配置、数据库初始迁移和基础检查。登录、上传、Sync V2 和官方 App 兼容性尚未实现。`/healthz` 成功仅表示 Worker 正在运行。

## 需求与开发顺序

- [完整中文需求文档](outputs/immich-cf-完整需求文档.md)：纳入 Git 管理，作为需求基线。
- [开发与环境说明](docs/development.md)：命令、目录、资源配置和验证边界。
- [P0 调查报告与版本冻结](docs/p0-report.md)：v3.3.1 源码契约已冻结；iOS 3.3.1 build 23 已由用户确认，实机验证待完成。
- [P0 契约验证清单](docs/p0-checklist.md)：源码调查、运行验证及关口状态。

## 本地启动

需要 Node.js 24（至少 24.9.0）、pnpm 11.25.0 和 Git。

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm dev
```

访问 `http://localhost:8787/healthz`。本地开发使用 dev 环境与本地模拟存储，无需 Cloudflare 登录。测试使用独立的非持久化存储，不读取开发图库。

```sh
pnpm check
```

此命令执行格式、静态检查、类型检查、本地 Worker/D1/R2 测试和 dry-run 构建。生成的类型、数据库文件和构建文件不纳入 Git。

## 环境与名称

| 资源   | 生产（默认配置） | 开发（dev）         | 验收（staging）         |
| ------ | ---------------- | ------------------- | ----------------------- |
| Worker | immich-cf-api    | immich-cf-api-dev   | immich-cf-api-staging   |
| D1     | immich-cf-db     | immich-cf-db-dev    | immich-cf-db-staging    |
| R2     | immich-cf-media  | immich-cf-media-dev | immich-cf-media-staging |

生产不添加 `-prod` 后缀。dev 已绑定真实 D1/R2 资源并部署；生产和 staging 的 D1 ID 仍为占位值，尚未创建对应远程资源。

开发环境健康检查：<https://immich-cf-api-dev.fun.workers.dev/healthz>。资源、验证结果和后续部署步骤见[开发环境部署记录](docs/deployment-dev.md)。

项目版本 `0.1.0` 是自身版本，不是伪装的 Immich 服务端版本。当前 `/api/*` 返回 501，避免未实现的写操作返回假成功。
