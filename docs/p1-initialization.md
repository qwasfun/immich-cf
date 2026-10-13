# P1 第二增量：用户初始化与会话撤销

日期：2026-10-14。基于官方 v3.3.1 固定提交 `db6e11ecc851228aec9c525abb0ee026d1f5055e`；iOS 3.3.1 build 23 仍待真机验收。此增量不代表完整初始化已通过。

## 源码证据与实现

官方 `mobile/lib/infrastructure/repositories/user_api.repository.dart` 的 `getMyUser()` 并行等待 `getMyUser()` 与 `getMyPreferences()`。此前偏好请求返回 501，会使这一 Future 失败。新增鉴权的 `GET /api/users/me/preferences`，返回冻结版本 `server/src/utils/preferences.ts` 的默认结构，按已归档 OpenAPI 检查必填项、类型和枚举。

新增 `GET /api/sessions`、`DELETE /api/sessions`、`DELETE /api/sessions/{id}`。列表只返回自己的未过期会话；批量撤销保留当前会话；单会话删除允许撤销当前会话。所有权约束直接写入删除 SQL，未知/他人 ID 均返回同一 400，非法 UUID 返回含 `errors[].path=["id"]` 的具体错误。撤销通过外键级联删除该会话同步检查点与待确认记录，旧令牌随后返回 401。

上游实现依据及 SHA-256 记录见 [补充源码索引](contracts/p1-initialization-sources.json)。这些是固定源码调查，不是参考服务端差分或 App 抓包。

## 数据与行为边界

- 新增迁移 `0003_session_details.sql`，只增加会话创建/更新时间，不修改用户、密码或图库。旧会话创建时间按原有固定 7 天有效期反推；更新时间以该值初始化，此前没有活动时间记录。
- 新会话记录真实创建时间；同步 reset 状态变化更新 `updatedAt`。不将它描述为每次访问的最后在线时间。
- 尚未采集设备信息：`deviceOS`、`deviceType` 为空，`appVersion` 为 null，不伪造为 iOS；列表不返回令牌或哈希。
- 偏好默认值是用户选项，不是服务端功能承诺；能力仍由 server/features 限定。默认日期按 UTC 固定为 2022-02-12，原版日期依赖服务端时区，此处是明确的兼容假设。下载默认 archiveSize 只是 DTO 值，不表示支持 4 GiB 上传/下载。
- 偏好 PUT、子会话创建、会话 PUT 仍明确返回 501；没有写入偏好，因此不新增 UserMetadataV1 事件。onboarding、媒体、上传、完整初始化和参考服务端差分留待后续增量。

## 验证和下一步

测试覆盖官方 App 的并行用户/偏好调用、偏好 schema、未登录拒绝、未实现写入不改变读取结果，以及会话列表隔离、秘密字段排除、非法 ID、跨用户撤销拒绝、Cookie 跨源拒绝、保留当前会话和令牌撤销后失效、同步待确认记录级联清理。

部署需先应用 0003 再发布 Worker；无需重置 dev 测试账户。test/prod 保持未发布。本地迁移和公网部署执行结果以本轮交付说明为准，不把已实现等同已上线。

### 本轮执行记录

- 代码提交 `29946d0`；`pnpm check` 通过（12 项测试、格式、lint、类型检查与 dry-run 构建），`pnpm contracts:verify` 通过。
- dev 迁移 0003 已成功应用，Worker 版本 `230051b0-7231-47fe-b782-4bfa43c22f7b`，入口 https://immich-cf-api-dev.fun.workers.dev。
- 公网冒烟：health/discovery/ping 200、登录 201、users/me 200、Sync 200、ACK 204、preferences 200、sessions 200、删除本次当前会话 204；随后用该令牌访问 users/me 返回 401。
- 未执行公网批量会话撤销，以保留用户既有登录；批量撤销及跨用户隔离由本地测试验证。没有操作 test/prod，也没有执行官方 iOS 真机验收。

下一步：使用官方 iOS 连接 dev 记录实际阻塞请求，补齐 onboarding 和必要只读接口；固定图片读取及非空 Sync、并发 reset/ACK 差分、Free CPU 测量仍是 G1 前置项。
