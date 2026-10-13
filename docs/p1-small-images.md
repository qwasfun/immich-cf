# P1 小图片最小闭环

日期：2026-10-14。固定客户端契约 v3.3.1，目标真机 iOS 18.7.9 / Immich 3.3.1 build 23。此增量允许少量测试图片，不开放完整照片备份。

## 可用接口

| 接口                                | 行为                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| POST /api/assets                    | multipart assetData；新建 201，账户内相同 SHA-1 重复 200，返回 id/status      |
| POST /api/assets/bulk-upload-check  | 最多 1000 项；Base64/hex SHA-1，返回 accept 或 duplicate/reject               |
| GET /api/assets/{id}                | 资产详情，仅所属用户可读                                                      |
| GET/HEAD /api/assets/{id}/original  | 私有 R2 原图                                                                  |
| GET/HEAD /api/assets/{id}/thumbnail | thumbnail/preview/fullsize/original 均暂返回同一小原图，无转码                |
| POST /api/sync/stream               | AssetsV2 请求发 AssetV2；AssetMetadataV1 发 mobile-app 元数据；沿用 ACK/reset |
| GET /api/server/media-types         | JPEG/PNG；不声明视频及 sidecar 支持                                           |

### 限制与校验

JPEG/PNG 静态图片，单文件最多 2 MiB；请求体最多 2 MiB + 64 KiB，不依赖 Content-Length 进行最终限流。宽高不超过 4096，最多 400 万像素；每用户最多 20 张，D1 触发器约束并发容量。文件类型按内容头识别，接受官方 App 默认的 application/octet-stream 文件 MIME。

必填 fileCreatedAt/fileModifiedAt；isFavorite 支持 true/false，visibility 仅 timeline，duration 仅 0。拒绝 HEIC、视频、Live Photo、sidecar、动画 PNG。保留一项最多 8 KiB 的 mobile-app JSON 元数据及相应 Sync 事件；旧 deviceId/deviceAssetId 不参与跨用户标识。字段错误具体返回 errors/path，不回显提交值。

## 数据与可靠性边界

0005 新增 assets 表，D1 自增 seq 在提交时分配；同用户 checksum 唯一，R2 随机对象键不含原始文件名。先写 R2 再发布 D1 资产记录；并发重复请求清理输掉竞争的对象。R2/D1 之间无分布式事务，数据库响应不明确时保留对象，可能产生孤立对象；本轮没有自动垃圾回收，不因重试删除可能已成功保存的文件。确定的容量触发器拒绝会清理本次对象。

Sync 使用补零整数序列不透明 ACK；按 seq 返回最多 20 张现有资产，不支持资产修改/删除，因此没有资产删除事件或分页。检查点按会话隔离。AuthUserV2 游标包含资产序列以更新真实存储用量。AssetExifsV1 暂为空；时间和尺寸来自提交字段与文件头，EXIF 时区、GPS、相机和旋转方向未提取。localDateTime 暂使用归一化后的 fileCreatedAt，非完整 EXIF 本地日期语义。

文件检查只覆盖容器头、尺寸和结束标记，不是完整图片解码器，不承诺检测所有损坏文件；JPEG EXIF 旋转、色彩管理和跨设备解码仍需真机验证。未生成 thumbhash；返回 null。edited=true 在无编辑记录时返回原图。Range 暂忽略并返回完整 200，小图响应不提供公共缓存或公开 R2 URL。

没有实现删除、相册、图片编辑、Socket.IO 上传通知、后台全量备份、HEIC 转码。上传后可能需要主动刷新/重开 App 触发 Sync。必须先按本页验收，再扩展范围；此增量不代表 G1 或完整兼容通过。

## 验证

源码依据：[上传与显示来源索引](contracts/p1-small-images-sources.json)、冻结 OpenAPI 的 AssetMediaResponseDto / SyncAssetV2 / SyncAssetMetadataV1 / AssetResponseDto。官方 UploadRepository 使用 assetData 和返回 id；image_url_builder 使用受支持的 original/thumbnail 路径。

本地 workerd + D1/R2 集成测试覆盖：PNG/JPEG、尺寸限制中的字节上限、无鉴权/跨用户拒绝、错误格式/日期/校验和/可见性、重复及并发同图去重、bulk-check、资产详情 schema、原图/各缩略图入口的字节一致、Sync schema 与 ACK 后增量、清除游标重新拉取、重启后图片仍可读。无真实用户图片；fixtures 为程序绘制的 320×240 合成图片。

未验证：生产负载和 Free CPU、存储故障注入、孤立对象清理、容量竞争极限、reset/ACK 并发、官方 Dart 完整运行和 iOS 非空图库实际显示。服务端测试通过不能替代最后一项。

## 真机步骤

1. 使用现有 dev 测试账号，保持批量自动备份关闭。
2. 部署冒烟会保留一张蓝底绿色方块、文字 immich-cf dev 的合成 PNG；刷新照片页或重开 App，观察时间线缩略图。
3. 打开该图片，确认预览正常；重启后再查看。该图片不是手机本地照片，能显示才有助于确认远程读取链路。
4. 再手动上传一张缩小后的静态 JPEG/PNG（小于 2 MiB、400 万像素），确认上传成功并刷新。不要直接启用整个系统相册备份。
5. 报告图片是否出现、预览是否清晰、上传/Sync/图片加载日志及北京时间。请勿发送含访问令牌的完整请求头。

## 2026-10-14 部署记录

- 代码提交 `89cb6df`；`pnpm check` 通过（14 项测试、类型、lint、格式、构建），冻结契约校验通过。
- dev 已应用 0005；Worker 版本 `6a8e5c92-2d9e-4629-a602-2520c33af3ae`。test/prod 未变更。
- 公网合成 PNG 上传 201、重复上传 200；thumbnail/preview 与 original 均 200，SHA-256 与本地原文件一致；未登录读取 401。
- Sync 返回 AuthUserV2、AssetV2、SyncCompleteV1，ACK 204，后续 AssetsV2 拉取不重复返回已确认资产。
- 留给官方 App 验收的资产 ID：`79abe1b1-2bab-4e42-9d77-2aa2dbb2e984`，文件名 `immich-cf-dev-test.png`，320×240；仅 dev 测试账户可读。冒烟会话已注销，不改动用户既有会话。
- 首次 PowerShell `-Form` 上传被 multipart 解析拒绝（400）；显式构造标准 multipart、采用 application/octet-stream 文件段后通过。具体编码差异尚未定位，不能据此声称接受所有合法 multipart 变体；官方 iOS 实际上传仍需验证。
- 尚未收到本增量的官方 iOS 显示结果；仅服务端上传→Sync→媒体读取闭环通过，不将其记为 App 已显示或非空图库全量兼容。

## 真机缺陷：资产 owner 外键与 UserV1 修复

用户于北京时间 2026-10-14 02:44:57 提供日志：SyncStreamRepository.updateAssetsV2 写 remote_asset_entity 失败，SQLite 787 FOREIGN KEY constraint failed，测试图未显示。此前服务端测试只校验 DTO 和字节，没有覆盖客户端关系约束，遗漏了此问题。

冻结源码确认 remote_asset_entity.owner_id 引用 UserEntity.id；AuthUserV2 仅更新 auth_user_entity，不能代替 UserV1 更新 user_entity。此前服务端接受 UsersV1 请求但未发出当前用户，故缺少资产所有者外键记录。

修复：在请求 UsersV1 且尚未 ACK 时发出当前用户 UserV1，顺序为 AuthUserV2（如需）、UserV1、用户元数据、资产、Complete；不会返回其他账户。UserV1 采用独立检查点，不受已有 AuthUserV2/Complete ACK 影响。无数据库迁移、不删除会话、不重置手机数据、不重传图片。

官方 SyncStreamService 在 _handleSyncData 成功之后才 ACK；updateAssetsV2 失败会 rethrow。因此受影响会话应在下次同步补齐 UserV1 并重新接收未确认资产。若客户端仍报错，应继续收集日志，不将服务端修复当作真机显示已通过。

新增回归使用真实 SQLite 引擎及从官方表定义提取的最小外键模型：仅插入 AuthUser 时可复现 FK 失败，按修复流顺序插入 UserV1/AssetV2 成功；覆盖已确认 AuthUser 的旧会话、ACK 后不重复、reset 重建顺序。该模型不是完整 Dart/Drift 或官方 iOS 运行时。

修复提交 `ec0a34d`；完整检查通过（15 项测试）。Wrangler 两次发布遇到网络错误后，使用 cloudflare-api 发布同一 dry-run 构建产物，deployment ID `72ad0ef20d7f41209a89890b3dcad4a6`。无迁移待执行。公网验证原图去重仍为相同 ID、媒体读取 200、字节一致、未授权 401；事件顺序为 AuthUserV2 → UserV1 → AssetV2 → Complete，UserV1.id 与 AssetV2.ownerId 相等，ACK 204，增量不重复。未清空用户检查点或图片，待用户再次刷新确认实际显示。
