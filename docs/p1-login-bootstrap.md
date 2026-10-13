# P1 第三增量：登录初始化 HTTP 接口

日期：2026-10-14；固定官方源码仍为 v3.3.1 / `db6e11ecc851228aec9c525abb0ee026d1f5055e`，目标安装版 iOS 3.3.1 build 23。新增源码摘要见 [来源索引](contracts/p1-initialization-sources.json)。

## 调用核对

| 官方源码入口                                         | 调用/行为                                             | 当前服务端                                             |
| ---------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| LoginForm.getServerAuthSettings / ServerInfoNotifier | 发现、version、features、config                       | 已实现                                                 |
| AuthNotifier.login/saveAuthInfo                      | 登录、并行 users/me 与 preferences，用户刷新超时 7 秒 | 已实现；并行请求已测                                   |
| LoginForm.handleSyncFlow / SyncApiRepository         | 22 家族 Sync stream、ACK                              | 空媒体库；新增 onboarding 元数据事件                   |
| LoginForm 登录成功分支                               | 发起 websocketProvider.connect，随后切换 TabShell     | Socket.IO 尚未实现；该连接不被 await，不代表真机无影响 |
| TabShell                                             | 默认进入本地时间线；相册刷新在切换对应 tab 时触发     | 非空图库及相册 API 留待后续                            |
| users/me/onboarding（官方 UserService）              | 初始 false、PUT 写入、DELETE 回到 false               | 本轮新增完整 HTTP 读写                                 |

源码没有显示 onboarding 是这条移动端密码登录链路的必经请求；它是已列入初始化契约的补充接口，不将其误称为已经观察到的真机阻塞。

## 实现与同步规则

- `GET /api/users/me/onboarding`：鉴权后读取本用户状态，未设置/删除返回 `{isOnboarded:false}`。
- `PUT`：仅接受布尔 `isOnboarded`，400 返回具体字段及修正要求，不回显提交值；成功 200。
- `DELETE`：成功 204，保留同步墓碑；不影响其他用户。
- `GET /api/server/media-types`：无需登录，返回 image/video/sidecar 三个空数组。当前尚无上传或媒体处理能力，不照抄上游支持格式来宣称支持。
- 新迁移 `0004_onboarding.sql`：每用户独立状态、删除标志和原子递增 revision；没有媒体数据或新增付费资源。
- 请求 UserMetadataV1 家族时，流发出当前用户的 UserMetadataV1 或 UserMetadataDeleteV1，然后 Complete；确认后不重复发送，删除后重建会获得新版本。新会话与 reset 后可以重建当前快照。
- ACK 为服务端不透明字符串，onboarding 使用补零 20 位十进制 revision，不是上游 UUID 游标。官方 Dart 路径将 ACK 原样传回；尚未进行参考服务端差分。该游标域仅用于 onboarding，扩展到其他 metadata key 前必须统一设计，不能直接混用。
- 对同一 key 同时比较更新/删除家族检查点，避免旧更新 ACK 重放导致删除状态复活；并发写通过单条 D1 upsert 递增，不依赖本机时钟。

## 验证边界

13 项本地测试通过，包含默认值、非法类型、重启持久化、增量 ACK、删除/重建、旧 ACK 重放、并发版本递增、跨用户 GET/Sync 隔离和媒体能力 schema。既有身份、会话撤销、空库 Sync 测试同时回归；类型检查、lint、格式与构建通过。

部署顺序为先应用 0004，再发布 dev；test/prod 不变。没有把用户 onboarding 状态等同于服务端配置中的管理员初始化标志。

尚未验收：官方 iOS 完整登录及页面行为、Socket.IO 实时连接、参考服务端差分、网络中断和 reset/ACK 并发竞争、非空图库与媒体、Workers Free CPU。此交付是初始化 HTTP 与空库同步增量，不是完整 App 兼容性通过。
