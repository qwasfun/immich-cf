# immich-cf 项目文档

## 需求与兼容协议

- 项目需求基线。[完整中文需求文档](immich-cf-完整需求文档.md)
- Immich 3.4.1 的登录、上传、相册与 Sync 协议范围、未开放的上游功能和各环境发布记录。[3.4.1 对齐记录](upstream-v3.4.1.md)
- v3.3.1 初始调查和版本冻结。[P0 调查报告](p0-report.md)
- 源码调查、运行验证和验收关口。[P0 契约验证清单](p0-checklist.md)

## Web 功能

- 中文照片墙、原件下载、收藏、相册、回收站、账号管理、完整图库查找与浏览器上传。[网页版 V1](web-v1.md)
- 年月定位、上下自动加载，返回页面或刷新后恢复浏览位置。[时间线浏览](web-v1.md#时间线浏览)
- 所选照片和整本相册的 ZIP 分包下载，包含 Live Photo 的照片与 MOV 原件。[批量下载](web-v1.md#批量下载)
- 照片及相册的限时访问链接、访客预览和撤销。[照片分享](web-v1.md#照片分享)
- 名称和描述搜索、四种排序、批量复制或移动、大图快捷设置封面。[相册整理](web-albums.md)
- 单张和批量归档或取消归档、独立列表和年月定位。[照片归档管理](web-photo-archive.md)
- 单张和批量标签管理、1～5 星评分与组合筛选。[照片标签与评分](web-photo-labels.md)
- EXIF 相机、GPS 和时间展示、描述与位置编辑、批量时间偏移及时区修正。[照片资料与时间修正](web-photo-metadata.md)

## 开发与部署

- 本地调试、检查命令、仓库目录和资源配置。[开发与环境说明](development.md)
- 客户端地址、环境资源和 dev → test → prod 发布流程。[三环境开发与发布](environments.md)
- 开发环境资源、验证结果与再次部署步骤。[开发环境部署记录](deployment-dev.md)
- 测试和生产环境首次发布、登录方式与验收结果。[测试与生产部署记录](test-prod-deployment.md)
- 中文网页版 V1 的 dev 发布与逐项验证。[Web dev 发布记录](web-v1-dev-deployment.md)
- 桌面、手机布局、底部快捷导航、网格密度、侧栏编辑和键盘操作的三环境发布与验收。[新版界面三环境发布](ui-refactor-deployment-2026-11-13.md)
- Workers Paid 确认及免费预算优化决策。[Paid 开发决策](paid-development-decision.md)

## 阶段验收

- 各阶段实现、待验收项与后续顺序。[开发进度与剩余任务](development-progress.md)

### P1 登录、上传与同步

- 启用方式、创建测试用户、验证结果和未完成范围。[本地 PoC](p1-local-poc.md)
- 偏好读取、会话列表与撤销、迁移和验证边界。[用户初始化与会话管理](p1-initialization.md)
- 官方登录调用、onboarding 读写、元数据同步和媒体能力边界。[登录初始化 HTTP 接口](p1-login-bootstrap.md)
- 固定官方参考容器、16 个身份或空库用例、脱敏报告和已知差异。[官方参考对比](p1-reference-comparison.md)
- 非空图库的两种图片、元数据、部分 ACK、重置重放与媒体读取。[非空图库参考对比](p1-nonempty-reference.md)
- UTF-8、换行边界、背压与部分确认后的重连矩阵。[分块传输与中断恢复](p1-stream-transport.md)
- 同步轮次隔离、原子校验和重复确认恢复。[Sync reset/ACK 恢复](p1-sync-recovery.md)
- 直接快照、并发隔离、失败恢复与验收。[显式 reset 对齐](p1-explicit-reset.md)
- 持久上传预约、故障注入、同步重试和剩余关口。[上传可靠性与异常恢复](p1-reliability.md)
- 上传限制、Sync、私有读取与官方 iOS 小图片真机验收。[小图片闭环](p1-small-images.md)

### P2 媒体与存储

- 六项媒体任务、真实混合拒绝样本、特殊格式与退出关口。[P2 逐项计划与退出验收](p2-plan.md)
- JPEG/HEIC 与 MOV 配对、流式上传、整组生命周期、Images 免费预览和 v2 导出。[Live Photo 原件备份](p2-live-photo-support.md) · [dev 验证](p2-live-photo-support-dev-deployment.md)
- 每账号逻辑资产名额、Live Photo 计数和分批导出。[资产容量](p2-asset-capacity.md)
- 混合队列中的大小边界、格式拒绝、重复失败、存储对账与未验证风险。[混合队列恢复](p2-mixed-queue.md)
- 已识别动态请求的持久拦截及部分备份风险。[Live Photo 防护](p2-live-photo.md)
- 放行经验证的静态截图说明、日期、修改时间和方向，保留动态照片防护。[静态 XMP 修复](p2-static-xmp.md) · [iOS 截图补充](p2-screenshot-xmp-2026-11-16.md)
- JPEG 扫描段后的元数据、截断检查、渐进式和重启标记。[JPEG 扫描结构检查](p2-jpeg-structure.md)
- PNG 图片头、调色板、数据块顺序和残缺动画检查。[PNG 结构检查](p2-png-structure.md)
- 原图缺失或大小异常时允许重传，恢复已有资产。[备份预检查恢复](p2-bulk-recovery.md)
- 阻止返回异常原图或 304，覆盖读取竞态与重传恢复。[异常原图读取保护](p2-media-recovery.md)
- 上传中断报错、清理失败时保留超限状态和重试验证。[上传流中断恢复](p2-upload-stream.md)
- UTF-8 字节、总文本量、字段数量、额外文件和拒绝后重试。[上传表单字段边界](p2-upload-fields.md)
- 逐块解析、分段头上限、完整 EOF 校验、有界文件缓存和无残留恢复。[增量 multipart 解析](p2-streaming-multipart.md)
- 跨发布者预约按逻辑图片去重、未完成上传计数和末位并发验证。[上传名额去重计数](p2-upload-quota.md)
- 原生 SHA-1 写入确认、历史对象渐进升级、预检查和读取保护。[R2 原图校验与等长异常恢复](p2-r2-integrity.md)
- 分阶段计时、脱敏失败报告、客户端连接与服务端保存证据。[上传超时诊断](p2-upload-transport.md)
- 接近 4 MiB 的上传结果、传输阶段和闭环进度。[curl 边界复测](p2-curl-retest.md)
- 代理和 TLS 对照、有界同图重传与强 ETag 分段读取。[curl 连接恢复](p2-curl-tls.md)
- 历史 EXIF 预检、原图校验、原子同步版本与并发重试。[历史 EXIF 安全修复](p2-exif-repair.md)
- 新上传图片的方向和布局尺寸、原件保留与真机验收。[EXIF 方向](p2-exif-orientation.md)
- PNG CRC、混合失败序列、100 个合成变体与真实图库验收边界。[上传完整性与剩余矩阵](p2-upload-matrix.md)
- 分段读取、条件请求、HEAD、撤销后访问隔离和暂缓的 CPU 超预算项。[私有媒体 Range/ETag](p2-media-http.md)
- 平台 CPU 实测、免费预算关口与后续限制。[CPU 预算探针](p2-budget-probe.md)
- 标准 KDF 线上边界、同步检查点读取优化与复测。[认证评估与同步优化](p2-auth-sync-cpu.md)
- 原图和预约保留、校验副本、持久源引用与有界重试。[历史原生摘要升级与恢复](p2-integrity-upgrade.md)
- 分页观察原图异常和保留预约，供运维只读核对。[只读存储对账](p2-storage-audit.md)
- 分页覆盖历史保留原图、识别未知摘要与损坏、保留引用。[历史原图引用对账](p2-source-audit.md)
- 按需重算摘要，识别无原生摘要旧原图的等长损坏并保留源及预约。[历史原图只读完整校验](p2-source-verification.md)
- 私人清单、隔离本地存储、独立尺寸和去重统计，默认在本地验收。[真实 JPEG/PNG 样本验收工具](p2-real-media-corpus.md)
- 6400 万像素和单边 16384 上限、该次发布的 4 MiB 与 Live Photo 防护、公网验证和 iOS 验收步骤。[手机尺寸原图与像素上限](p2-image-limits.md)
- 48 MP PNG、存储故障和重启恢复、并发与 reset/ACK 回归及合成公网探针。[高像素原图异常恢复](p2-large-pixel-recovery.md)

### P3 可靠同步与数据一致性

- 本地迁移、删除与关系历史、保留水位、可重跑历史压缩和合成容量证据。[可靠同步与数据一致性](p3-reliable-sync.md)
- 本地内部认领、永久引用隔离与崩溃恢复，保留原图和预约。[R2 摘要副本安全清理](p3-r2-cleanup.md)
- 本地有界分页识别引用、摘要预约及对象已删除的未完成任务，供运维只读盘点。[只读存储盘点与任务恢复](p3-storage-inventory.md)
- 2026-10-30 部署 `54f50e4`，记录 0014～0018 迁移、同步和预览验证及维护入口限制。[P3 dev 部署记录](p3-dev-deployment.md)
- 业务变更守卫、独立关系消费模型与缺失预约引用盘点。[读取一致性与双会话恢复](p3-read-consistency.md)

### P4 个人图库

- 单张和批量收藏、原子权限检查和同步。[收藏原型](p4-favorites.md)
- 161 项本机回归、双会话收藏、reset/ACK 和原图保护。[收藏与同步保护 dev 验证](p4-favorites-dev-deployment.md)
- 个人相册增删改查、私有关系、自动和手动封面、独立 Sync 家族和恢复语义。[个人相册、关系与封面](p4-personal-albums.md)
- 174 项本机回归，双会话关系、封面、reset 和原图保留验证。[个人相册 dev 验收](p4-albums-dev-deployment.md)
- 回收站、恢复和永久删除。[回收站说明](p4-trash.md)
- 显式运维授权、状态检查、原图校验和账号清单导出。[管理员状态与导出](p4-admin-export.md) · [dev 验收](p4-admin-export-dev-deployment.md)
