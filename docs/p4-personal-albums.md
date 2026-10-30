# P4：个人相册、照片关系与封面

## 已实现范围与冻结契约

保持官方 iOS Immich 3.3.1 build 23 不修改，沿用冻结 v3.3.1 的 OpenAPI 与 Sync 枚举：

| 操作                   | 路径                           | 结果                                               |
| ---------------------- | ------------------------------ | -------------------------------------------------- |
| 创建个人相册           | POST /api/albums               | 201 AlbumResponseDto，支持名称、描述和初始本人资产 |
| 列表与筛选             | GET /api/albums                | 200；支持 assetId、id、name、isOwned、isShared     |
| 相册详情               | GET /api/albums/{id}           | 200 AlbumResponseDto                               |
| 改名、描述、排序、封面 | PATCH /api/albums/{id}         | 200；重复设置不推进版本                            |
| 删除相册               | DELETE /api/albums/{id}        | 204；同账号已删除重试仍204                         |
| 添加本人照片           | PUT /api/albums/{id}/assets    | 200 BulkIdResponseDto[]；重复关系标记duplicate     |
| 移除照片关系           | DELETE /api/albums/{id}/assets | 200 BulkIdResponseDto[]；不存在关系标记not_found   |

删除相册/移除关系只修改元数据与同步记录，绝不删除 assets、R2原图、历史源或上传/摘要预约。同一照片可属于多个个人相册。归属验证在数据库触发器与提交时守卫中实施，不能通过猜测ID、批量混入他人ID或封面ID绕过权限。

当前仅个人相册；albumUsers只能省略或空数组，共享用户、key/slug访问和活动功能明确拒绝，不返回假成功。isShared=true/isOwned=false列表为空；assetId按官方语义优先过滤、忽略其他筛选。v3描述null保存为空字符串并以空字符串返回。

实验资源界限：每账号最多100个相册（数据库强制），名称最多255 UTF-8字节且非空/无控制字符，描述最多8192 UTF-8字节；单次最多1000个输入ID并去重。既有20个逻辑资产、4MiB、像素、Live Photo、密码和私有媒体限制不变。

## 封面与关系

首张加入照片自动成为封面；显式封面必须是本相册中当前本人照片。移除封面时，按剩余照片拍摄时间倒序/ID确定性选择替代；最后一张移除则封面为null。相册自动维护资产数、起止日期和业务更新时间。已退役资产级联移除关系并修正封面，同时保留原图。

任何批量添加若含缺失/非本人资产，整批404、无部分修改；重复有效关系按BulkIdResponse返回逐项结果。移除不存在的关系不触碰任何资产。输入错误返回具体字段、原因和修正要求，不回显私密提交值。

## 持久化与恢复

0021_personal_albums只新增表、索引与触发器，不重写旧资产或会话表。相册、关系、删除日志与单调同步序号同事务提交；新 album_owner_revisions 独立于资产版本，避免相册修改影响纯资产家族的读取守卫。旧六列sync_guards、五列sync_read_guards不改列数；新相册读取守卫使用独立临时表。

所有写入在同一D1 batch中重新检查会话所有权、数据库时钟有效期和禁用状态；业务、日志、封面与幂等预约一起成功或一起回滚。回放同一删除/关系变更不重复产生业务变化。相册删除日志保留、ID不复用；当前不压缩相册日志，避免未接入家族保留水位前错过删除。存储成本与完整预算尚未验收，不因元数据实现就宣称Free关口通过。

操作工具可为POST提供Idempotency-Key（最多128个字母/数字/连字符）：相同账号/键/内容恢复同一相册；冲突内容409；后续改名/移除后重放创建不会覆盖编辑或重新添加关系；删除后不复活。官方App无需增加该头；其无键POST按标准创建语义处理，连续相同名称POST允许不同相册，不把名称当唯一键。未收到新建响应时应先刷新列表，不能宣称无键POST具备exactly-once保证。

## Sync 与官方消费顺序

已核对冻结服务端sync.service/repository及手机sync_stream.repository：AlbumV2不带owner，必须另发AlbumUserV1(role=owner)。AlbumAssetCreateV2/UpdateV2使用同一SyncAssetV2载荷；照片关系由AlbumToAssetV1独立应用。

新增家族：AlbumV2/AlbumDeleteV1、AlbumUserV1/AlbumUserDeleteV1、AlbumAssetCreateV2/AlbumAssetUpdateV2、AlbumToAssetV1/AlbumToAssetDeleteV1。先用户与资产，再相册、owner、关系，删除遵循冻结相册家族顺序。所有事件按本账号单调版本、请求检查点和高水位筛选；移除后重新添加的当前关系抑制陈旧删除。投递登记与相册版本守卫、既有epoch/history/read守卫原子提交，竞态返回409，显式reset不会提交旧快照。其他账号与纯资产请求不被无关相册写入阻塞。

reset:true全量包含相册、owner与所有关系，ACK旧轮次继续拒绝；另一会话ACK不受影响。独立SQLite消费模型启用资产/相册/owner/关系外键，验证创建、更新、删除、重放和重建后状态一致。这不是官方App真机替代。

## 验证边界

本机覆盖CRUD/筛选、冻结响应schema、封面/空相册、重复关系、多相册同图、事务故障回滚、并发创建/封面竞争、100相册上限、越权、会话撤销/过期/禁用、响应丢失重试、独立Sync家族、reset/ACK隔离、资产退役和原图保留。

通过完整本机检查后，按既有授权发布dev并用两个新会话验证上述主流程，测试只创建带标识的临时相册并清理，不改变真实相册或原图。CPU超预算继续暂缓，test/生产不晋升。完整P4仍有回收站/恢复、管理/导出和真机两设备验收等剩余任务，见开发进度。

本轮完整本机检查：174项通过、0失败、0跳过；专项13项通过。格式/lint/类型/dry-run通过，构建229.57KiB / gzip55.78KiB；冻结279操作/53来源不变。[本机脱敏汇总](contracts/p4-albums-validation.json)。
