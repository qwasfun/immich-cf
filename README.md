# immich-cf

- [P2 只读存储对账](docs/p2-storage-audit.md)：分页观察原图异常与保留预约，不执行清理。

基于 Cloudflare Workers / D1 / R2、以完全不修改官方 Immich App 为硬约束的兼容服务端验证项目。

新增 [Live Photo 原件备份与 Images 免费预览](docs/p2-live-photo-support.md)：JPEG/HEIC＋MOV 配对、流式上传、整组生命周期和 v2 导出；真实 iPhone 播放与恢复仍待独立验收。

测试账号已由用户确认升级Workers Paid，功能开发暂不受免费计划限制；当前约束以[Paid开发决策](docs/paid-development-decision.md)为准。

已推进个人相册、收藏和[回收站/恢复/永久删除](docs/p4-trash.md)，阶段结果以[开发进度](docs/development-progress.md)及各次dev验收记录为准；P2以下仍有真机、真实规模和预算退出项，不能据此认定项目已全部完成。

当前推进 **P4 个人图库功能**，P2媒体与完整兼容验收仍有未通过项：dev 已具备身份、会话、onboarding、有限 JPEG/PNG 上传、私有图片读取和资产 Sync。单张最多 4 MiB / 6400 万像素、单边 16384，每账户最多 20 张；官方 iOS 原小图片上传、显示与预览已获用户确认；高像素、混合队列、完整备份和 G1 仍待验收。`/healthz` 成功仅表示 Worker 正在运行。

## 需求与开发顺序

- [管理员状态与导出](docs/p4-admin-export.md)：显式运维授权、状态检查、校验原图和账号清单导出；[dev验收](docs/p4-admin-export-dev-deployment.md)。

- [P2 混合队列恢复](docs/p2-mixed-queue.md)：大小边界、格式拒绝、重复失败、存储对账及官方 App/Live Photo 未验证风险。
- [P2 Live Photo 防护](docs/p2-live-photo.md)：已识别动态请求的持久拦截与无法覆盖的部分备份边界。
- [普通静态 XMP 修复](docs/p2-static-xmp.md)：放行经验证的截图说明和创建时间，保留动态照片防护。
- [JPEG 扫描结构检查](docs/p2-jpeg-structure.md)：检查扫描段后的元数据和截断结构，覆盖渐进式与重启标记。
- [PNG 结构检查](docs/p2-png-structure.md)：校验图片头、调色板和数据块顺序，拒绝残缺动画结构。
- [备份预检查恢复](docs/p2-bulk-recovery.md)：原图缺失或大小异常时允许重传，恢复已有资产。
- [异常原图读取保护](docs/p2-media-recovery.md)：大小异常不返回图片或 304，覆盖读取竞态和重传恢复。
- [上传流中断恢复](docs/p2-upload-stream.md)：中断明确报错，清理失败不覆盖超限状态，重试无脏记录。
- [上传表单字段边界](docs/p2-upload-fields.md)：UTF-8 字节、总文本量、字段数量和额外文件限制，拒绝后的重试与 Live Photo 防护回归。
- [增量 multipart 解析](docs/p2-streaming-multipart.md)：逐块解析、分段头上限、完整 EOF 校验和无存储残留恢复；文件仍有界缓存。
- [上传名额去重计数](docs/p2-upload-quota.md)：跨发布者保留预约按逻辑图片只计一次，未完成上传仍占名额，并发最后名额回归。
- [R2 原图校验与等长异常恢复](docs/p2-r2-integrity.md)：原生 SHA-1 写入确认、历史对象渐进升级、预检查和媒体读取保护。
- [上传超时诊断](docs/p2-upload-transport.md)：分阶段计时与脱敏失败报告，区分客户端连接与服务端保存证据。
- [curl 边界复测](docs/p2-curl-retest.md)：接近 4 MiB 的上传结果、传输阶段与完整闭环进度。
- [curl 连接恢复](docs/p2-curl-tls.md)：显式代理/TLS 对照、有界同图重传与强 ETag 分段读取。

- [历史 EXIF 安全修复](docs/p2-exif-repair.md)：预检、原图校验、原子同步版本、并发与重试。

- [P2 EXIF 方向](docs/p2-exif-orientation.md)：新上传图片方向解析、布局尺寸、原始字节保留与真机验收边界。

- [P2 上传完整性与剩余矩阵](docs/p2-upload-matrix.md)：PNG CRC、混合失败序列、100 个合成变体及真实图库验收边界。

- [P2 私有媒体 Range/ETag](docs/p2-media-http.md)：分段读取、条件请求、HEAD 和撤销后的访问隔离；CPU 超预算暂缓。

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

- [P2 认证评估与同步优化](docs/p2-auth-sync-cpu.md)：标准 KDF 的线上边界、检查点读取优化与复测。

- [P2 历史原生摘要升级与恢复](docs/p2-integrity-upgrade.md)：保留原图及预约，校验副本、持久源引用和有界重试。

- [P2 历史原图引用对账](docs/p2-source-audit.md)：将保留原图纳入分页检查，区分未知摘要与损坏，保留全部引用。

- [P2 历史原图只读完整校验](docs/p2-source-verification.md)：按需完整重算摘要，识别无原生摘要旧原图的等长损坏，不修改源或预约。

- [P2 真实 JPEG/PNG 样本验收工具](docs/p2-real-media-corpus.md)：私人清单、隔离本地存储、独立尺寸和去重统计，不默认上传公网。

- [P2 手机尺寸原图与像素上限](docs/p2-image-limits.md)：6400 万像素、单边 16384，保留 4 MiB 与 Live Photo 防护；已部署 dev，含公网验证与 iOS 验收步骤。

- [P2 高像素原图异常恢复](docs/p2-large-pixel-recovery.md)：实际编码 48MP PNG、存储故障/重启/并发恢复与 reset/ACK 交错回归，以及固定合成公网探针。

- [P2 逐项计划与退出验收](docs/p2-plan.md)：六项任务、真实混合拒绝样本、特殊格式清单与未通过关口。

- [P3 可靠同步与数据一致性](docs/p3-reliable-sync.md)：本机迁移、删除/关系历史、保留水位、可重跑历史压缩和合成容量证据；未部署，P3 尚未整体验收。

- [P3 R2 摘要副本安全清理](docs/p3-r2-cleanup.md)：本机内部认领、永久引用隔离与崩溃恢复；原图和预约保留，本轮不部署。

- [P3 只读存储盘点与任务恢复](docs/p3-storage-inventory.md)：有界分页识别全部引用及摘要预约，发现对象已删除的未完成任务；本机内部验证，不自动清理。

- [P3 dev 部署记录](docs/p3-dev-deployment.md)：2026-10-30 部署 54f50e4，0014～0018 迁移与公网同步/预览冒烟通过，维护入口未开放。

- [开发进度与剩余任务](docs/development-progress.md)：各阶段真实完成边界与后续顺序。
- [P3 读取一致性与双会话恢复](docs/p3-read-consistency.md)：业务变更守卫、独立关系消费模型、缺失预约引用盘点。
- [P4 本机收藏原型](docs/p4-favorites.md)：单张/批量收藏、原子权限检查及同步；dev 发布与验证单独记录。

- [收藏与同步保护 dev 验证](docs/p4-favorites-dev-deployment.md)：161项本机回归后发布，双会话收藏/reset/ACK及原图保护通过。

- [P4 个人相册、关系与封面](docs/p4-personal-albums.md)：CRUD、私有关系、自动/手动封面、独立Sync家族与恢复语义。

- [个人相册 dev 验收](docs/p4-albums-dev-deployment.md)：174项回归后发布，双会话关系/封面/reset与原图保留验证通过。
