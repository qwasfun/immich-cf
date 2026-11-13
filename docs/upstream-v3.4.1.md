# Immich 3.4.1 协议对齐

2026-11-13（Asia/Shanghai）。当前兼容协议从 3.3.1 更新至官方 [v3.4.1](https://github.com/immich-app/immich/releases/tag/v3.4.1)，固定提交 `22b95194c80a2f2e6201093916b6c8c3d6d271dd`，移动端源码版本 `3.4.1+3040199`。对齐限于项目现有接口范围，不表示实现全部官方功能或通过真机验收。

## 变更

- `/api/server/version` 返回 `3.4.1`，补齐新版必需字段 `featureLevel: 1`。官方最高为 2；官方移动端 `ServerVersion.fromDto` 在等级 2 开启通行密钥，`PasskeyStore.enabled` 才进一步读取公开配置。兼容端尚未实现通行密钥，因此保持等级 1，使密码登录继续可用，避免误显示无法使用的入口。
- `/api/server/features` 补齐必需字段 `backups: false`。该字段指官方 FUTO 服务端备份集成，与现有照片上传、Live Photo 备份或账号导出不同。
- 归档新版 OpenAPI 原始字节，更新 287 个 operation 和 64 项固定提交来源摘要。保留旧 3.3.1 OpenAPI、manifest、来源清单及参考报告，避免将旧验证结果套用到新版本。
- 同步请求/事件枚举、客户端在 3.4.1 下选择的 22 个同步家族、JSON Lines 分帧、ACK/reset、资产/EXIF/相册/会话/登录响应 schema 均未改变。资产和会话更新接口的 OpenAPI 鉴权元数据有变化，兼容端继续对写操作检查登录和归属，未支持的写入明确拒绝。
- 移动端原生 `NetworkApiImpl.swift`、`URLSessionManager.swift` 与旧冻结源码逐字节相同。前台上传调整日志，后台取消增加 Live Photo 两组任务清理，不改变上传字段或照片与 MOV 的配对协议。
- 更新隔离参考服务器的 3.4.1 amd64/arm64 摘要及官方 Compose 中的 Valkey 摘要；参考比较脚本从 manifest 读取预期版本。旧镜像验证记录独立保留。

服务端协议版本独立于项目自身版本 `0.1.0`。本次不新增数据库迁移，不修改媒体格式、配额或原件。官方新增 Passkeys、FUTO 备份、JPEG XL、HIF 扩展仍处于本项目既有实现范围之外；Web 平面标签也不等同于官方移动端的层级标签 API/同步。

## 验证

`pnpm contracts:verify` 已核对新版 OpenAPI/许可证摘要、287 个操作、64 项来源、运行时代码中的版本与同步枚举。集成测试从当前 manifest 定位 schema，新增版本能力协商和通行密钥入口关闭检查。

`pnpm check` 完整通过：328 项测试，0 失败、0 跳过，格式、规范、前后端类型检查及 Web/Worker dry-run 构建均通过。新版能力协商、登录/偏好/会话、JPEG/PNG/HEIC/Live Photo、资产/EXIF/相册 Sync、ACK/reset、越权与失败恢复及现有 Web 功能均包含在回归内。首轮受限执行环境无法连接本机测试端口（curl 连接错误），切换至允许本机连接的运行环境后完整通过，未改动业务代码或放宽断言。

dev 发布前完成 16 项公网检查，记录既有账号用量和资产同步内容的摘要，并退出临时会话。

## dev 发布与公网验证

发布提交 `1c3fa128bfa64b648b2d9ef1a367b9884f44fa74`；通过项目发布脚本构建并部署。Worker 版本 `5efa9e8b-f89a-4534-a903-c3d122e17331`，deployment `1e5314c0-9188-46e7-ad66-4b4d9898b86a`，控制面确认承接 100% 流量。38 项既有迁移无需追加，D1/R2/Images/Assets 绑定及每 5 分钟 Cron 保持开发环境配置。

地址：[dev](https://immich-cf-api-dev.fun.workers.dev)。升级后 45 项公网检查全部通过：

- 实际返回 3.4.1、featureLevel 1 和 backups false，发现、配置、媒体类型及密码登录正常，Bearer/Cookie 身份一致。
- 官方当前 22 个同步家族可读取，ACK 后增量为空；独立新会话具有相同图库，显式 reset 重放一致，旧 ACK 被拒绝，另一会话检查点保持正常。
- 升级前后资产同步内容摘要及账号用量一致，两份现有原件的实际下载 SHA-1 与同步 checksum 一致。相册、时间线、地图、回忆、标签、GPS 任务、偏好及会话接口正常。
- 字段校验指出具体 email 字段且不回显无效提交值；匿名私有访问、跨站 Cookie 操作、跨环境 dev 凭据被拒绝；未实现的通行密钥入口继续返回 501。
- test/prod 公网仍为 3.3.1，控制面部署 ID 和 Worker 版本与升级前一致。本次仅发布 dev，未晋升 test/生产。
- 验证不写入媒体，所有临时登录会话均已退出且再访问返回 401。验证前后用量保持。

结构化脱敏证据见 [dev 验证记录](contracts/v3.4.1-dev-validation.json)。本机 Docker Linux 引擎当前不可连接，因此未将官方 3.4.1 容器差分标为通过；manifest 已将当前参考版本的 `runtimeVerified` 设为 false。真实 iOS/Android 3.4.1 的登录、备份、播放、恢复和双设备同步仍待真机验收。

静态证据：[来源与差异记录](contracts/v3.4.1-source-review.json)、[当前冻结清单](compatibility-manifest.json)、[契约说明](contracts/README.md)。
