# API 契约矩阵（v3.3.1）

核查日期：2026-10-13。依据固定提交的 OpenAPI 与移动端调用源码；本表不是抓包结果，也不是已实现接口清单。所有路径含 `/api` 前缀。完整参数、必填项、枚举、nullable 和返回 schema 见归档 [OpenAPI](contracts/upstream/immich-v3.3.1.openapi.json)；全部操作见 [operations.json](contracts/operations.json)。

OpenAPI 的成功码不能代替实际错误契约；流媒体、Cookie、Socket.IO 以及客户端容错必须结合下文及实机测试。表中“有”表示 OpenAPI 声明鉴权；Sync 额外要求会话，API key 不足。

## 初始化与登录

| 操作                   | 方法与路径                      | 鉴权 | 请求体 schema      | 成功响应（码 / schema）              |
| ---------------------- | ------------------------------- | ---- | ------------------ | ------------------------------------ |
| pingServer             | GET `/api/server/ping`          | 无   | —                  | 200 / ServerPingResponse             |
| getServerVersion       | GET `/api/server/version`       | 无   | —                  | 200 / ServerVersionResponseDto       |
| getServerFeatures      | GET `/api/server/features`      | 无   | —                  | 200 / ServerFeaturesDto              |
| getServerConfig        | GET `/api/server/config`        | 无   | —                  | 200 / ServerConfigDto                |
| getSupportedMediaTypes | GET `/api/server/media-types`   | 无   | —                  | 200 / ServerMediaTypesResponseDto    |
| login                  | POST `/api/auth/login`          | 无   | LoginCredentialDto | 201 / LoginResponseDto               |
| logout                 | POST `/api/auth/logout`         | 有   | —                  | 200 / LogoutResponseDto              |
| validateAccessToken    | POST `/api/auth/validateToken`  | 有   | —                  | 200 / ValidateAccessTokenResponseDto |
| getAuthStatus          | GET `/api/auth/status`          | 有   | —                  | 200 / AuthStatusResponseDto          |
| getMyUser              | GET `/api/users/me`             | 有   | —                  | 200 / UserAdminResponseDto           |
| getMyPreferences       | GET `/api/users/me/preferences` | 有   | —                  | 200 / UserPreferencesResponseDto     |
| getUserOnboarding      | GET `/api/users/me/onboarding`  | 有   | —                  | 200 / OnboardingResponseDto          |
| getSessions            | GET `/api/sessions`             | 有   | —                  | 200 / array<SessionResponseDto>      |
| updateSession          | PUT `/api/sessions/{id}`        | 有   | SessionUpdateDto   | 200 / SessionResponseDto             |

## 上传与元数据

| 操作                    | 方法与路径                            | 鉴权 | 请求体 schema              | 成功响应（码 / schema）                                  |
| ----------------------- | ------------------------------------- | ---- | -------------------------- | -------------------------------------------------------- |
| checkBulkUpload         | POST `/api/assets/bulk-upload-check`  | 有   | AssetBulkUploadCheckDto    | 200 / AssetBulkUploadCheckResponseDto                    |
| uploadAsset             | POST `/api/assets`                    | 有   | AssetMediaCreateDto        | 200 / AssetMediaResponseDto; 201 / AssetMediaResponseDto |
| getAssetInfo            | GET `/api/assets/{id}`                | 有   | —                          | 200 / AssetResponseDto                                   |
| getAssetMetadata        | GET `/api/assets/{id}/metadata`       | 有   | —                          | 200 / array<AssetMetadataResponseDto>                    |
| getAssetMetadataByKey   | GET `/api/assets/{id}/metadata/{key}` | 有   | —                          | 200 / AssetMetadataResponseDto                           |
| updateAssetMetadata     | PUT `/api/assets/{id}/metadata`       | 有   | AssetMetadataUpsertDto     | 200 / array<AssetMetadataResponseDto>                    |
| updateBulkAssetMetadata | PUT `/api/assets/metadata`            | 有   | AssetMetadataBulkUpsertDto | 200 / array<AssetMetadataBulkResponseDto>                |
| updateAsset             | PUT `/api/assets/{id}`                | 有   | UpdateAssetDto             | 200 / AssetResponseDto                                   |
| updateAssets            | PUT `/api/assets`                     | 有   | AssetBulkUpdateDto         | 204 / 无响应体                                           |

## 媒体读取

| 操作           | 方法与路径                            | 鉴权 | 请求体 schema | 成功响应（码 / schema） |
| -------------- | ------------------------------------- | ---- | ------------- | ----------------------- |
| viewAsset      | GET `/api/assets/{id}/thumbnail`      | 有   | —             | 200 / string            |
| downloadAsset  | GET `/api/assets/{id}/original`       | 有   | —             | 200 / string            |
| playAssetVideo | GET `/api/assets/{id}/video/playback` | 有   | —             | 200 / string            |

## 同步

| 操作          | 方法与路径              | 鉴权 | 请求体 schema    | 成功响应（码 / schema） |
| ------------- | ----------------------- | ---- | ---------------- | ----------------------- |
| getSyncStream | POST `/api/sync/stream` | 有   | SyncStreamDto    | 200 / 无响应体          |
| getSyncAck    | GET `/api/sync/ack`     | 有   | —                | 200 / array<SyncAckDto> |
| sendSyncAck   | POST `/api/sync/ack`    | 有   | SyncAckSetDto    | 204 / 无响应体          |
| deleteSyncAck | DELETE `/api/sync/ack`  | 有   | SyncAckDeleteDto | 204 / 无响应体          |

## 相册、删除及恢复

| 操作                 | 方法与路径                       | 鉴权 | 请求体 schema      | 成功响应（码 / schema）        |
| -------------------- | -------------------------------- | ---- | ------------------ | ------------------------------ |
| getAllAlbums         | GET `/api/albums`                | 有   | —                  | 200 / array<AlbumResponseDto>  |
| createAlbum          | POST `/api/albums`               | 有   | CreateAlbumDto     | 201 / AlbumResponseDto         |
| getAlbumInfo         | GET `/api/albums/{id}`           | 有   | —                  | 200 / AlbumResponseDto         |
| updateAlbumInfo      | PATCH `/api/albums/{id}`         | 有   | UpdateAlbumDto     | 200 / AlbumResponseDto         |
| deleteAlbum          | DELETE `/api/albums/{id}`        | 有   | —                  | 204 / 无响应体                 |
| addAssetsToAlbum     | PUT `/api/albums/{id}/assets`    | 有   | BulkIdsDto         | 200 / array<BulkIdResponseDto> |
| removeAssetFromAlbum | DELETE `/api/albums/{id}/assets` | 有   | BulkIdsDto         | 200 / array<BulkIdResponseDto> |
| deleteAssets         | DELETE `/api/assets`             | 有   | AssetBulkDeleteDto | 204 / 无响应体                 |
| restoreAssets        | POST `/api/trash/restore/assets` | 有   | BulkIdsDto         | 200 / TrashResponseDto         |
| emptyTrash           | POST `/api/trash/empty`          | 有   | —                  | 200 / TrashResponseDto         |
| restoreTrash         | POST `/api/trash/restore`        | 有   | —                  | 200 / TrashResponseDto         |

## 非目标候选与辅助信息

| 操作            | 方法与路径                                    | 鉴权 | 请求体 schema     | 成功响应（码 / schema）            |
| --------------- | --------------------------------------------- | ---- | ----------------- | ---------------------------------- |
| getStorage      | GET `/api/server/storage`                     | 有   | —                 | 200 / ServerStorageResponseDto     |
| getAboutInfo    | GET `/api/server/about`                       | 有   | —                 | 200 / ServerAboutResponseDto       |
| getVersionCheck | GET `/api/server/version-check`               | 有   | —                 | 200 / VersionCheckStateResponseDto |
| getPartners     | GET `/api/partners`                           | 有   | —                 | 200 / array<PartnerResponseDto>    |
| getAllPeople    | GET `/api/people`                             | 有   | —                 | 200 / PeopleResponseDto            |
| searchMemories  | GET `/api/memories`                           | 有   | —                 | 200 / array<MemoryResponseDto>     |
| searchAssets    | POST `/api/search/metadata`                   | 有   | MetadataSearchDto | 200 / SearchResponseDto            |
| searchSmart     | POST `/api/search/smart`                      | 有   | SmartSearchDto    | 200 / SearchResponseDto            |
| getMainPlaylist | GET `/api/assets/{id}/video/stream/main.m3u8` | 有   | —                 | 200 / string                       |
| getAssetEdits   | GET `/api/assets/{id}/edits`                  | 有   | —                 | 200 / AssetEditsResponseDto        |
| getAssetOcr     | GET `/api/assets/{id}/ocr`                    | 有   | —                 | 200 / array<AssetOcrResponseDto>   |

## 调用链与具体实现约束

表列接口是实现候选，不代表每个接口均阻塞启动；调用次数、顺序和页面依赖还需实机抓包确认。OpenAPI 成功响应不覆盖全部运行时错误。

### 发现、版本和鉴权

客户端先规范化输入 URL（默认 HTTPS、去尾部斜杠），尝试根路径下 `/.well-known/immich`，200 时读取 `api.endpoint`，可处理相对路径；随后补 `/api` 并 ping（5 秒超时）。发现响应可采用 `{"api":{"endpoint":"/api"}}`，这是基于客户端读取逻辑的实现建议，非本次实测响应。验证根 URL 和显式 `/api` 两种输入，不能造成 `/api/api`。

登录 POST `/auth/login` 返回 201，必须包含 LoginResponseDto 的所有 required 键：`accessToken,isAdmin,isOnboarded,name,profileImagePath,shouldChangePassword,userEmail,userId`。App 保存令牌后仍调用 `/users/me`；只实现登录成功 JSON 不足以完成首次登录。配置/能力/偏好等对象不能用 `{}` 代替；完整 required 列表见 OpenAPI。

iOS `NetworkApiImpl.setRequestHeaders` 将令牌设置为共享 Cookie `immich_access_token`，另有 `immich_is_authenticated` 和 `immich_auth_type`；域来自服务端 URL，path 为 `/`，HTTPS 下 secure。URLSessionManager 用共享 Cookie 存储供原生请求使用。因此 **Cookie 会话鉴权是必需路径**，不能只实现 Bearer；Cookie 属性、退出清除、重启恢复、后台下载、跨地址切换和失效行为仍需实机验证。OpenAPI 列出的 Cookie/Bearer/API key 不是 Sync 无会话鉴权的许可。

客户端兼容提示只比较部分主版本关系，不能作为完整协议协商。具体 Sync 能力由服务端 SemVer 决定；在相应类型尚未实现前不得伪装为 3.3.1 并宣称兼容。

### 上传、去重与失败

- POST `/assets` 使用 multipart/form-data，文件字段 `assetData`。OpenAPI 必填 `assetData,fileCreatedAt,fileModifiedAt`。移动端额外发送 `deviceAssetId,deviceId,isFavorite`；后台还发 `filename,duration`，metadata 是 multipart 字符串中的 JSON。两条路径均需接受，不能仅照 JSON schema 拒绝移动端仍发送的旧字段。
- 新建成功使用 201，重复路径使用 200，响应为 `{id,status}`；status 枚举以 AssetMediaStatus 为准。前台客户端只接受 200/201 且要求字符串 id。Worker 不得在 R2/数据库持久化完成之前返回成功，不得用异步受理 202 冒充兼容。
- bulk-upload-check 请求 `{assets:[{id,checksum}]}`，响应 `{results:[{id,action,assetId?,isTrashed?,reason?}]}`，按客户端 id 对应结果。官方服务端按用户及文件校验和去重，支持 `x-immich-checksum` 快速重复路径；本次尚未核实固定 iOS 在何种路径发送该请求头，不能假设必有。SHA-1 文件校验和及 Sync base64 需与参考实现核对，不能用 ETag 替代。
- Live Photo 前台先上传隐藏的视频，成功后在照片中传 `livePhotoVideoId`。不支持完整 Live Photo 时必须验证不会造成成功假象/孤儿对象；不得静默标记整组完成。
- 大文件允许拒绝。前台收到 413 会直接显示固定 `Error(413) File is too large to upload`，不读取自定义错误体；其他失败尝试读取字符串 message/error。后台 UploadTask 配置 retries=3，具体各错误下重试和队列行为尚未运行。无 Content-Length、中途超限、失败清理和不可绕过的流式上限均需测试；产品文件上限值仍按需求/负载验收确定。
- 普通字段错误应返回可定位的结构化错误，并在 message 中给出字段名、原因和修正要求，例如“fileCreatedAt：必须为有效的 ISO 8601 日期时间”。不得照抄上游笼统的 `Validation failed` 作为唯一提示，不得回显敏感值。自有前端展示具体原因；官方 App 的固定提示限制如上，不承诺能展示自定义字段结构。

### 媒体、实时更新和降级

客户端 URL builder 使用 `/assets/{id}/thumbnail?size=thumbnail|preview&edited=...`，可附加 thumbhash 缓存参数 `c`；原图用 `/original?edited=...`，视频用 `/video/playback`。必须携带同一会话权限，正确返回真实媒体字节和 Content-Type。OpenAPI 的 200/binary 不能代替 Range/206/416、HEAD、缓存与重定向鉴权实测。

Socket.IO 使用 `${endpoint.path}/socket.io`，标准基址下即 `/api/socket.io`，transport 为 websocket。监听 `AssetUploadReadyV1/V2`、`AssetEditReadyV1/V2`、相册/删除/恢复/配置等事件。普通 WebSocket 不是等价替代；哪些事件是无手动刷新的必需项尚未运行确认，不能笼统宣称不需要实时通道。

| 功能                               | 初期降级候选                                          | 不允许的行为/待验收                                    |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| OAuth、搜索、地图、人脸、OCR、转码 | 相应 feature=false；实际无数据的读取返回完整空 schema | 仍被请求的 Sync 类型不能直接使整流 400；页面行为待实机 |
| 伙伴、回忆、人物等关系             | 产品范围外且真实无记录时，同步家族为空                | 不能丢弃已有关系或构造假实体；写请求不可返回假成功     |
| 编辑/侧车/复杂视频                 | 明确不支持并返回可理解的失败                          | 已有资产原图不可因此不可读；官方 UI 是否能恢复待实机   |
| Socket.IO                          | 仅在实测核心闭环不依赖时允许暂缺                      | 上传后资产永不显示、持续错误/重试则不可接受            |

## 固定源码依据

- [发现与 API 初始化](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/services/api.service.dart)
- [登录后的用户刷新](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/providers/auth.provider.dart)
- [iOS Cookie 写入](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/ios/Runner/Core/NetworkApiImpl.swift)
- [iOS 共享网络会话](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/ios/Runner/Core/URLSessionManager.swift)
- [前台上传与错误解析](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/repositories/upload.repository.dart)
- [前台字段与 Live Photo](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/services/foreground_upload.service.dart)
- [后台字段与重试](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/services/background_upload.service.dart)
- [服务端去重及上传状态](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/server/src/services/asset-media.service.ts)
- [媒体 URL](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/utils/image_url_builder.dart)
- [Socket.IO 客户端](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/lib/providers/websocket.provider.dart)
- [iOS 构建号递增](https://github.com/immich-app/immich/blob/db6e11ecc851228aec9c525abb0ee026d1f5055e/mobile/ios/fastlane/Fastfile)
