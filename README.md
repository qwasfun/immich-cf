# immich-cf

基于 Cloudflare Workers / D1 / R2、以完全不修改官方 Immich App 为硬约束的兼容服务端验证项目。

当前为 **P1 小图片实验**：dev 支持身份、会话、onboarding、少量 JPEG/PNG 上传、私有图片读取和资产 Sync。单张最多 2 MiB / 400 万像素，每账户最多 20 张；官方 iOS 单张上传、显示与预览已获用户确认；完整备份仍待验收。`/healthz` 成功仅表示 Worker 正在运行。

## 需求与开发顺序

- [完整中文需求文档](outputs/immich-cf-完整需求文档.md)：纳入 Git 管理，作为需求基线。
- [开发与环境说明](docs/development.md)：命令、目录、资源配置和验证边界。
- [P0 调查报告与版本冻结](docs/p0-report.md)：v3.3.1 源码契约已冻结；iOS 3.3.1 build 23 已由用户确认，实机验证待完成。
- [P0 契约验证清单](docs/p0-checklist.md)：源码调查、运行验证及关口状态。
- [P1 本地 PoC](docs/p1-local-poc.md)：启用方式、创建测试用户、验证结果与未完成范围。
- [P1 用户初始化与会话管理](docs/p1-initialization.md)：偏好读取、会话列表与撤销、迁移及验证边界。
- [P1 登录初始化 HTTP 接口](docs/p1-login-bootstrap.md)：官方登录调用核对、onboarding 读写及元数据同步、媒体能力边界。
- [P1 官方参考对比](docs/p1-reference-comparison.md)：固定容器、16 个身份/空库用例、脱敏报告与已知差异。
- [P1 分块传输与中断恢复](docs/p1-stream-transport.md)：UTF-8、换行边界、背压与部分确认重连矩阵。
- [P1 Sync reset/ACK 恢复](docs/p1-sync-recovery.md)：同步轮次隔离、原子校验与重复确认恢复。
- [P1 上传可靠性与异常恢复](docs/p1-reliability.md)：持久化上传预约、故障注入、同步重试及剩余关口。
- [P1 小图片闭环](docs/p1-small-images.md)：上传限制、Sync 与私有读取、真机步骤及剩余风险。

## 本地调试

需要 Node.js 24（至少 24.9.0）、pnpm 11.25.0 和 Git。

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:dev
pnpm dev
```

访问 `http://localhost:8787/healthz`。`pnpm dev` 使用本地代码与远程 dev D1/R2，需要 Cloudflare 授权；`pnpm dev:local` 使用纯本地存储。测试保持隔离。详见[三环境开发与发布](docs/environments.md)。

```sh
pnpm check
```

此命令执行格式、静态检查、类型检查、本地 Worker/D1/R2 测试和 dry-run 构建。生成的类型、数据库文件和构建文件不纳入 Git。

## 环境与名称

| 资源   | 生产（默认配置） | 开发（dev）         | 验收（test）         |
| ------ | ---------------- | ------------------- | -------------------- |
| Worker | immich-cf-api    | immich-cf-api-dev   | immich-cf-api-test   |
| D1     | immich-cf-db     | immich-cf-db-dev    | immich-cf-db-test    |
| R2     | immich-cf-media  | immich-cf-media-dev | immich-cf-media-test |

生产不添加 `-prod` 后缀。dev 已绑定真实 D1/R2 资源并部署；生产和 test 的 D1 ID 仍为占位值，尚未创建对应远程资源。

开发环境健康检查：<https://immich-cf-api-dev.fun.workers.dev/healthz>。资源、验证结果和后续部署步骤见[开发环境部署记录](docs/deployment-dev.md)。

项目版本 `0.1.0` 是自身版本。远程 dev 已开启 P1，仅已实现路由开放；test/prod 尚未发布；版本接口的 3.3.1 用于选择被调查的协议分支，不代表完整兼容，未实现写操作仍返回 501。

- [P1 显式 reset 对齐](docs/p1-explicit-reset.md)：直接快照、并发隔离、失败恢复与验收。

- [P1 非空图库参考对比](docs/p1-nonempty-reference.md)：两种图片、元数据、部分 ACK、重置重放和媒体读取。

- [P2 CPU 预算探针](docs/p2-budget-probe.md)：平台 CPU 实测、免费预算关口及后续限制。
