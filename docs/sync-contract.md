# Sync V2 契约调查与实现约束

日期：2026-10-13。基线：Immich v3.3.1，完整 SHA 见 [冻结清单](compatibility-manifest.json)。结论级别为**源码核实**；尚未运行参考服务端、官方 App 或差分回放。

## 1. 协议与版本选择

“Sync V2”不意味着所有事件名都带 V2。服务端版本 >=3.0.0 启用 Assets/PartnerAssets/AlbumAssets/Albums V2；>=3.3.0 启用 AuthUsersV2、MemoriesV2、MemoryToAssetsV2、AssetFacesV3。能力判断直接比较服务端版本，不能靠 `/server/features` 将这些请求全部关掉。

在服务端报告 3.3.1 时，移动端按下列顺序请求 22 个类型（精确数组同时保存在 manifest）：

```text
AuthUsersV2, UsersV1, AssetsV2, AssetExifsV1, AssetEditsV1,
AssetMetadataV1, PartnersV1, PartnerAssetsV2, PartnerAssetExifsV1,
AlbumsV2, AlbumUsersV1, AlbumAssetsV2, AlbumAssetExifsV1,
AlbumToAssetsV1, MemoriesV2, MemoryToAssetsV2, StacksV1,
PartnerStacksV1, UserMetadataV1, PeopleV1, AssetFacesV3, AssetOcrV1
```

请求类型是复数（如 `AssetsV2`），事件类型是单数（如 `AssetV2`）。完整 31 个请求枚举及事件枚举归档于 manifest/OpenAPI。不能将“不做人脸/伙伴/回忆”解释为拒绝整个同步请求：无数据的家族可不发送实体，但必须安全完成流；若已有关系/元数据，则不得静默丢失。

## 2. HTTP 与逐行编码

| 方法与路径              | 请求/响应                                   | 约束                                                             |
| ----------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| POST `/api/sync/stream` | JSON `{types: [...], reset?: boolean}`；200 | `Content-Type: application/jsonlines+json`，不是 JSON 数组或 SSE |
| GET `/api/sync/ack`     | 200，`[{type, ack}]`                        | 当前会话的各事件类型检查点                                       |
| POST `/api/sync/ack`    | `{acks: string[]}`；204                     | 最多 1000 个；无响应体                                           |
| DELETE `/api/sync/ack`  | `{types?: SyncEntityType[]}`；204           | 未传 types 删除该会话全部；指定则删除对应类型                    |

以上操作必须具有登录会话；OpenAPI 通用安全声明列出 API key 不代表 Sync 接受无会话 key。

每行严格为 `JSON.stringify({type,data,ack}) + '\n'`，UTF-8。ACK 编码是 `type|updateId` 或 `type|updateId|extraId`；额外 ID 可能是 backfill 进度或 `complete`。它不是裸 UUID，也不是分页页码。`SyncAckV1` 的 ACK 前缀可以是被推进的 backfill 类型，不能机械要求等于事件 type。

客户端用 UTF-8 流解码后按 `\n` 分割，保留尚未闭合的尾部；EOF 时不解析没有换行的最后一段。因此**最后一行也必须有换行**。批量阈值为 5000 条，不是网络分块大小，不能将一个 HTTP chunk 当作一个事件。未知枚举在 `fromJson(...)!` 处可能失败，不保证可忽略。

实现差异（2026-10-14）：下节为上游源码行为。immich-cf 的 reset/clear 后 ACK 加入同步轮次后缀，事务隔离和重复确认恢复见 [P1 Sync 恢复](p1-sync-recovery.md)；该后缀需官方 iOS 复测。

## 3. ACK、reset 和完成状态机

1. 客户端先取得服务端版本；本地升级迁移可能 DELETE 旧的 AlbumV1、AssetV1/V2 和 EXIF 家族 ACK，再开启流。因此旧事件枚举仍要支持清理。
2. 服务端按当前 session 读取检查点；以固定 `nowId` 划定本轮上界。普通更新为 `ack < updateId < nowId` 且升序；删除审计也有自己的游标。部分 backfill 有额外范围条件，不能将所有查询简化成同一个 SQL。
3. 客户端将连续相同类型事件分组，先应用到本地数据库，再提交该组最后一条 ACK。崩溃/ACK 丢失会重放，服务端写入和客户端可见状态必须可幂等恢复。
4. 检查点按 `(sessionId, type)` 隔离；两台设备不能共用单一用户游标。上游 setAcks 当前对同类型取最后一个值，并留有“选最新”和“完善校验”的 TODO。不能宣称上游已提供单调推进或可靠 ACK 防伪保障。
5. pending reset 或完成 ACK 超过 30 天时，发送 `{"type":"SyncResetV1","data":{},"ack":"SyncResetV1|reset"}` 后结束。客户端清空远端缓存、ACK reset，然后重新开启流。请求 `reset:true` 也会先调用重置进度；其具体运行交互仍需差分验证。
6. 正常结尾发送 `SyncCompleteV1`，data 为 `{}`，ACK 为 `SyncCompleteV1|<nowId>`。客户端也会提交该 ACK。`nowId` 采用 UUIDv7 时间语义，过期判断读取前 48 位时间；不能用任意自增整数替换线上的 UUID。
7. 客户端当前未显式要求收到 Complete 才将普通流结束视为成功。服务端异常中断必须保留重试条件，不得提前发 Complete。验收工具应独立检查 Complete，避免把静默截断当成功。

上游删除审计保留窗口为 31 天（MAX_DAYS + 1），与 30 天重置判断配套。immich-cf 可选择内部存储方式，但要保证离线超窗触发重建；缩短 tombstone 保留而不重置客户端会产生幽灵资产。

## 4. 服务端顺序、关系与数据形状

服务端不按客户端数组顺序执行，而使用 `SYNC_TYPES_ORDER`。基线顺序见上游 service：用户、伙伴、资产、堆栈、伙伴资产/堆栈、相册资产、相册/成员/关联、EXIF/OCR、回忆、人物/人脸、用户元数据、资产元数据、编辑。各家族内部区分删除、更新与 backfill；相关资料存在性和关联 ACK 必须满足后才发送依赖更新。

例如相册资产增量更新会受相册关联 ACK 约束；backfill 用两个 ID 记录父关系与实体进度，并可发 `SyncAckV1` 推进空批次完成状态。删除不仅包括 `AssetDeleteV1`，还包括相册关联、伙伴、堆栈、人脸、编辑和元数据的删除事件。非目标家族无记录时可为空，但不能制造不存在的父记录或跨用户泄漏数据。

`SyncAssetV2` 的必填键包括 `id, ownerId, originalFileName, thumbhash, checksum, fileCreatedAt, fileModifiedAt, createdAt, localDateTime, duration, type, deletedAt, isFavorite, visibility, livePhotoVideoId, stackId, libraryId, width, height, isEdited`。其中多项允许 null，但**允许 null 不等于允许缺字段**。duration 为可空非负整数；checksum 和非空 thumbhash 经 base64 序列化。精确枚举、required 与 nullable 以归档 schema 为准，不能照 REST 资产 DTO 猜测。

## 5. D1 实现前的约束

- 业务变更与可同步的 updateId/删除审计须具有一致提交语义；同一轮固定上界，游标排序稳定，不能用可重复时间戳独立作游标。
- 建立会话检查点、每类变更索引、关系 backfill 进度、删除审计与 reset 状态；所有查询附带 owner/授权范围。具体表与索引在 P1/P2 设计验证，当前仅有项目元数据表。
- Workers 流式写出并处理背压/取消，不将完整图库一次加载内存。数据库分批读取不能遗漏同时间写入；分批边界、并发写入和重连必须做差分测试。
- ACK 严格校验的安全增强须避免误拒绝合法 backfill ACK；先通过固定版差分用例，再确定签名或游标防篡改策略。不得直接改变官方 App 发送的数据格式。

## 6. 后续必须执行的测试

| 用例                               | 预期                                      | 当前证据           |
| ---------------------------------- | ----------------------------------------- | ------------------ |
| 空库/首轮/增量                     | 完整初始状态，随后仅所需变化，有 Complete | 源码；未运行       |
| 按单字节切块/UTF-8 跨块/尾行缺换行 | 合法流一致；缺换行被验收工具拒绝          | 解析器审计；未运行 |
| 数据库应用后 ACK 失败/中途断线     | 重放不丢数据、不产生重复可见项            | 未运行             |
| 两会话不同进度                     | 互不覆盖 ACK                              | 存储键核实；未运行 |
| 删除、恢复、相册关联删除           | 本地状态与参考一致，无幽灵资产            | 未运行             |
| backfill 暂停/完成/空批次          | 两段游标与 SyncAckV1 正确推进             | 源码；未运行       |
| reset / >30 天 / 旧类型 ACK 清理   | 重建完成，不无限 reset                    | 源码；未运行       |
| 非目标家族为空                     | 整轮同步可完成，无未知类型失败            | 待实机             |
| 并发写入跨 nowId、流中报错         | 下轮可见、不提前完成                      | 未运行             |

## 源码定位

以下均固定到本次 SHA，文件摘要见 [source-inventory](contracts/source-inventory.json)：

- [序列化与 ACK](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/server/src/utils/sync.ts)
- [服务端顺序、reset、backfill 与完成事件](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/server/src/services/sync.service.ts)
- [查询边界与权限过滤](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/server/src/repositories/sync.repository.ts)
- [会话检查点与 UUIDv7 上界](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/server/src/repositories/sync-checkpoint.repository.ts)
- [客户端分块解析](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/infrastructure/repositories/sync_api.repository.dart)
- [客户端本地应用、ACK 与 reset 重连](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/domain/services/sync_stream.service.dart)
- [版本能力表](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/domain/models/server_capability.model.dart)
