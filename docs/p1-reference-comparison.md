# P1 固定参考服务端对比

日期：2026-10-14。首次运行冻结 Immich v3.3.1 官方服务端，执行身份、初始化与空图库 Sync 的真实 HTTP 对比。官方 App 保持不修改；本轮没有运行 Dart/Flutter 客户端。

## 环境与复现

[环境配置及命令](../infra/reference/README.md)。服务端 linux/amd64 镜像摘要与 compatibility-manifest 固定值一致，容器 API 返回 3.3.1。Postgres/Valkey 取冻结版本官方 Compose 摘要，见 [来源哈希](contracts/p1-reference-sources.json)。所有容器使用 immich-cf-reference 项目名、独立卷、随机数据库密码，服务器仅暴露本机 22830；不连接现有 Immich 或 Cloudflare 数据。

比较对象为实际官方容器和全新本地 workerd + D1/R2 的 immich-cf。每次创建合成普通用户；参考库保留合成用户，本次最终首轮 Sync 出现 4 条 UserV1（管理员与历次合成用户）。该数量依赖夹具历史，不作为固定兼容断言。未运行 machine-learning 服务；能力接口的默认 true 不代表实际验证了相应能力。

脱敏结果：[16 个用例的机器可读报告](contracts/p1-reference-comparison.json)。10 项投影相同，6 项不同。投影比较状态码、字段结构/空值类型、事件顺序与 ACK 段数；版本、能力、默认偏好、onboarding 和配置白名单比较实际值。账号、令牌、UUID 与时间戳只保留类型；没有保存用户图片或 Cookie。对象属性顺序不影响比较。

**相同投影不代表完整契约相同**：不比较所有字符串值、Cookie 属性、日期格式、响应时间、所有 DTO 枚举或异常分支。reset 之后的重复确认与竞态由已有本地回归覆盖，本轮对比只记录双方 reset:true 返回的差别。

## 已修正

`GET /api/server/config` 缺少官方实际返回的 `oauthAccountManagementUrl`。关闭 OAuth 时现在显式返回空字符串，不声明 OAuth 可用；新增回归验证此字段及未登录认证状态拒绝。修复后配置响应字段结构一致。

认证状态差异经源码复核后保留：官方 `AuthService.getAuthStatus` 的 `expiresAt` 来自 session.expiresAt，`pinExpiresAt` 才是 PIN 提权期限。immich-cf 有 7 天会话期限，返回 expiresAt 是正确语义；未启用 PIN，不返回 pinExpiresAt。本轮没有删除有效的会话到期字段。

## 仍存在的差异

| 用例                   | 官方本次结果                                                                         | immich-cf                                                | 决策                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------- |
| features               | 默认开启搜索、人脸、OCR、回收站等                                                    | 非目标能力为 false                                       | 保持真实能力声明，不伪造实现                                        |
| config-values          | publicUsers=true；服务端 onboarding=false；trashDays=30/minFaces=3/userDeleteDelay=7 | publicUsers=false；已有实验用户即 onboarding=true；0/1/0 | dev 有限范围差异；不是用户 onboarding 状态，完整管理员配置未实现    |
| auth-status / sessions | 默认会话未返回 expiresAt                                                             | 明确返回有限会话期限                                     | 保留安全期限，字段符合可选契约                                      |
| initial-stream         | AuthUserV2、所有本次可见用户、Complete；avatarColor=null                             | 只发当前用户；默认 primary；Complete                     | publicUsers=false 与隐私范围一致；颜色为合法默认值，非逐字段相同    |
| reset-stream           | 显式 reset:true 直接重新发送完整快照并以 Complete 结束                               | 返回本轮 SyncResetV1，确认后重建                         | 已知协议行为差异，仅 dev 保留；尚未证明所有调用方等价，后续专项处理 |

用户已确认的 App 手动同步重置通过，不足以证明它一定发送了 reset:true，也不替代本表差异验证。不得为了让对比通过而关闭 epoch/事务隔离，或开放其它用户数据。

## 验证与关口

- 官方镜像摘要与版本门禁、合成普通用户登录、首轮 Sync 与 ACK 的真实调用通过；两端 ACK 后增量均只返回 Complete。
- 版本、配置字段结构、未登录/错误密码状态与错误结构、登录结构、令牌验证、当前用户结构、默认偏好、用户 onboarding、增量同步投影一致。
- 全量自动回归新增一项配置/期限语义用例，共 31 项；参考对比为单独命令，需要 Docker，不自动塞入常规 CI。
- P1-05 从“未执行参考环境”推进为“身份/空库 HTTP 与 Sync 子集已执行，差异已记录”。P0 参考运行项具备证据，P0/P1 整体退出及 G1 尚未通过。
- 下一优先项：reset:true 与官方行为的兼容决策及回归，然后非空图库对比、真实客户端调用轨迹与 Free CPU 评估。上传/媒体、Cookie、后台备份、全部家族和性能不是本报告的验证结论。

本轮生产逻辑仅补一个配置字段；发布只面向 dev，不创建或晋升 test/prod。
