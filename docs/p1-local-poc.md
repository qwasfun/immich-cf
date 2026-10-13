# P1 第一增量：本地身份与空库 Sync PoC

日期：2026-10-13。目标客户端：用户报告的官方 iOS 3.3.1 build 23。承接 [P0 调查](p0-report.md)的有限技术验证许可。**本增量是本地协议实验，不是 P1 整体验收，也不是官方 App 已兼容。**

## 已实现范围

| 范围       | 行为                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 发现与连接 | `/.well-known/immich`、`/api/server/ping`                                                                                           |
| 版本与能力 | version、features、config；实验中以 3.3.1 选择被冻结的协议分支，功能标志仅开启 passwordLogin                                        |
| 身份       | 本地离线创建测试用户、bcrypt cost 12、密码登录、Cookie/Bearer、users/me、validateToken、auth/status                                 |
| 会话       | 32 字节随机令牌，仅存 SHA-256 摘要；有效期 7 天；退出删会话并清 Cookie；禁用用户即时失效                                            |
| 基础防护   | 具体字段错误、不回显输入；JSON 体最多 64 KiB；拒绝超 72 UTF-8 字节密码；账号每窗口 5 次/IP 每窗口 20 次登录，窗口自首次请求起 60 秒 |
| 空库 Sync  | 接受固定客户端请求的 22 家族；发出当前 AuthUserV2 和 Complete；逐行 UTF-8 且尾行换行；ACK、按类型删除 ACK、reset 重建               |
| 隔离与幂等 | session/type 检查点；只接受当前会话发出/已确认的 ACK，重复 ACK 可确认，普通 ACK 不倒退                                              |

没有资产表或媒体成功响应，因此其它家族当前真实为空；上传、媒体、相册等未实现请求仍返回 501。生产/staging 即使误设实验开关也不启用。`APP_ENV=development` 且 `ENABLE_P1_POC=true` 才开放上述路由；所有可部署配置默认 false。没有远程数据库迁移、账号创建或部署操作。

该实验返回的 3.3.1 是目标协议选择值，不是 immich-cf 自身版本（仍为 0.1.0），也不代表提供完整 Immich 3.3.1。响应附 `X-Immich-Cf-Stage: p1-empty-library-poc`；healthz 在启用实验时显示相应 stage。

## 本地启动

1. `pnpm install --frozen-lockfile`。
2. `pnpm db:migrate:local`，应用 0001 和新增 0002。新表为 users、sessions、sync_checkpoints、sync_deliveries、login_buckets。
3. 复制 `.dev.vars.example` 为 `.dev.vars`。如已有此文件，只合入开关，不覆盖已有内容。
4. 通过标准输入创建测试用户 SQL，然后只导入本地 D1。脚本不开放注册 API、不创建默认密码，不调用远程 API。

PowerShell 示例（不要用真实生产账户，密码不写入命令历史）：

```powershell
$p1Email = Read-Host '测试邮箱'
$p1Name = Read-Host '显示名称'
$p1Password = Read-Host '测试密码（至少 15 字符，UTF-8 最多 72 字节）' -AsSecureString
@{ email = $p1Email; name = $p1Name; password = (ConvertFrom-SecureString $p1Password -AsPlainText) } | ConvertTo-Json -Compress | pnpm p1:create-local-user
Remove-Variable p1Password
pnpm exec wrangler d1 execute IMMICH_CF_DB --env dev --local --file work/local-user.sql
pnpm dev
```

`work/local-user.sql` 含邮箱和密码哈希，不含明文密码，属于敏感本机材料且被 Git 忽略。脚本再次运行会覆盖这个临时 SQL；导入重复邮箱时数据库拒绝，不会偷偷重置密码。该版本没有密码变更、管理员管理界面或账号恢复功能。

手机不能直接访问电脑 localhost；本轮未建立公网隧道或暴露测试账户，不能据此直接进行 iOS 真机验收。

## 验证结果

`pnpm test` 中 9 组测试通过：4 组既有 Worker/D1/R2 骨架测试，5 组新增 P1 测试。新增测试使用实际本地 workerd 和 D1，独立状态目录为忽略的 `work/p1-test-*`，不读取本机开发图库或远程数据。

- 发现、能力、配置与版本的 required/type/enum/nullable 基础结构检查，依据已归档 OpenAPI；不是完整 JSON Schema 验证器。
- 具体字段错误、非法凭据一致响应、UTF-8 密码上限、请求体上限、登录限流。
- Cookie/Bearer、令牌摘要持久化、Worker 重启恢复、矛盾凭据拒绝、跨源 Cookie 写请求拒绝、退出和过期。
- 22 家族空库请求、AuthUserV2 结构、末行换行、Complete、重复 ACK、跨会话 ACK 拒绝、增量、reset 和旧类型清理。

测试不包含官方 iOS/Dart 进程、参考服务端差分、网络逐字节截断、资产/关系 backfill、同时 reset/ACK 的并发压力或真实 Cloudflare CPU。以上不得标为已通过。

## 密码成本与上线关口

采用固定版本 bcryptjs 3.0.3，cost 12；不为了 Free 降低成本。库对超过 72 字节输入会截断，因此在验证前主动拒绝；参见 [bcryptjs 官方说明](https://github.com/dcodeIO/bcrypt.js)。本机测试中登录 HTTP 耗时约 250 ms，包含数据库及运行时开销，**不是线上 CPU 数据**。

Cloudflare 官方 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)列明 Free CPU 预算；实际昂贵哈希执行需要线上测量。低 PBKDF2 参数或自创链式 KDF 不是本轮的替代方案。远程启用之前必须测量 cost 12 的 CPU/失败情况；超出 Free 能力时按需求选择其它经过评估的方案、明确付费候选或 No-Go。

当前限流是 D1 的账号/IP 窗口防护，并非完整公网抗滥用方案。错误只记录请求 ID 与固定内部错误码，不记录密码、Cookie、SQL 参数或完整异常。

## 已知差异与下一步

| 项目  | 当前边界 / 下一步                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------- |
| P1-01 | 本地路由完成；开发资源沿用已有部署，本增量未上线                                                   |
| P1-02 | 登录与会话完成本地验证；preferences、onboarding、session 管理等启动依赖仍需参考 App 调用确认与补齐 |
| P1-03 | 空库闭环；固定测试照片、媒体读取、关系事件/backfill 未实现                                         |
| P1-04 | 基础字段/会话/重放验证；中途断线、并发 reset/ACK、超期窗口等仍待补测                               |
| P1-05 | 未执行官方参考服务端与 App 差分                                                                    |

与上游相比，PoC 的 ACK 更严格：仅接受实际发出且仍保留的 ACK；待确认记录保留 24 小时，已确认的检查点继续保留。reset ACK 要求当前待 reset 且单独提交。并发 stream/reset/ACK、长时间延迟 ACK 的兼容性尚未验收，公开启用之前需引入同步代次/事务控制并差分测试。不要将本实现直接扩展为有资产的可靠同步。

下一步先运行固定参考服务端，取得 iOS 系统/渠道与实际初始化调用；补齐偏好等依赖，再做固定图片读取及中断/并发验证。G0 仍为有限技术验证，P0/P1 的全量验收和 G1 均未通过。
