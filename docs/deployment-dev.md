# 开发环境部署记录

最新发布（2026-10-16）：媒体读取前检查原图大小，异常时不返回图片或 304，代码 `b589634`，dev 版本 `ee118fbb-5047-4dbf-b8c3-eef5053d06a7`。66 项回归、契约校验及公网媒体/备份预检查/Sync/ACK 通过。读取竞态及故障恢复仅本地注入验证。Wrangler 网络失败后重试成功，无新迁移，test/生产未变更。详见 [异常原图读取保护](p2-media-recovery.md)。CPU 超预算继续暂缓。

最新发布（2026-10-16）：备份预检查确认 R2 原图存在和大小，缺失/异常允许重传恢复，代码 `ed513d0`，dev 版本 `e929795d-fbd2-4525-b59d-357f1df8fe08`。65 项回归、冻结契约及公网预检查/原图/Sync/ACK 通过；存储故障仅本地注入验证。Wrangler 首次网络失败、重试成功，无新迁移，test/生产未变更。详见 [备份预检查恢复](p2-bulk-recovery.md)。CPU 超预算暂缓，真机自动恢复仍待验证。

最新发布（2026-10-16）：PNG 结构与残缺动画块检查，代码 `62e3445`，dev 版本 `457998d4-2d81-4441-bc56-bfef02389576`。64 项回归、冻结契约与公网 24 项用例通过，异常拒绝后正常图片上传/原图/去重/Sync/ACK 通过。Wrangler 发布，无新迁移，test/生产未变更。详见 [PNG 结构记录](p2-png-structure.md)。CPU 超预算暂缓，真机混合队列仍待验收。

最新发布（2026-10-16）：JPEG 全扫描结构与后置元数据检查，代码 `69b118f`，dev 版本 `a527e77f-a2bc-4e64-a72c-bd9c56b321ba`。63 项回归、冻结契约校验及公网 11 种 JPEG 用例通过，正常图原图/去重/Sync/ACK 通过；后置 Live Photo 与未知 XMP 仍拒绝。通过 Wrangler 发布，无新增迁移，test/生产未变更。详见 [JPEG 结构检查](p2-jpeg-structure.md)。本轮真机未验证，CPU 超预算继续暂缓。

最新发布（2026-10-16）：修复普通截图 XMP 被一律拒绝的问题，代码 `7862ec4`，dev 版本 `71f78ba4-af10-4b98-9663-213a6c5ce92c`。62 项回归含真实私有 PNG 全部通过；公网样本上传/去重/原图/Sync/ACK 通过，未知 XMP 和 Live Photo EXIF 配对标签仍拒绝。通过 cloudflare-api 替换内容，无数据库迁移或配置变更，test/生产未变更。详见 [静态 XMP 记录](p2-static-xmp.md)。

最新发布（2026-10-15）：单图片上传上限调整为 4 MiB，请求体为 4 MiB + 64 KiB，代码 a185c4b，dev 版本 471fc260-f305-498d-84cb-22c794c042a5。59 项回归、契约校验和公网混合上传/原图/Sync/ACK 通过。Wrangler 网络失败后通过 cloudflare-api 仅替换构建；数据库和配置保持原状。像素、格式、安全及同步隔离规则不变，test/生产未变更。详见 [4 MiB 记录](p2-mixed-queue.md)。

最新发布（2026-10-15）：不依赖动态先行请求和设备字段的 Live Photo 文件内元数据防护，提交 `054d864`，Worker `7f9388f1-543e-481c-bff4-6e46dd24752c`，D1 保持 0010。59 项回归、契约校验和公网五份合成样本拒绝/普通图 Sync/ACK 通过。未知私有元数据及 XMP 保守拒绝，可能影响普通照片；标记被移除等情况仍无法识别，真实样本和真机未验证。详见 [Live Photo 防护记录](p2-live-photo.md)。CPU 继续暂缓，test/生产未变更。

最新发布（2026-10-15）：已识别 Live Photo 请求的跨会话静态重试拦截，提交 `96799db`，Worker `baf599d6-6144-43b9-b2f3-333a64faf018`，D1 迁移 0010。57 项回归和契约校验通过；刚发布时首次公网检查失败，随后连续两次通过，详见 [Live Photo 防护记录](p2-live-photo.md)。这只是已登记标识的风险缓解，未解决无标记/未到达服务器等路径，官方 App 真机仍待验收。CPU 超预算继续暂缓，test/生产未变更。

最新发布（2026-10-15）：混合大小备份与不支持格式恢复测试，提交 `b33212f`，dev Worker `569f7db0-10d2-4885-9bb0-f8b5ebe2777e`。55 项回归、冻结契约校验、公网 10 项上传序列及原图/Sync/ACK 检查通过；运行逻辑未修改，D1 保持 0009。官方 App 混合队列及 Live Photo 部分备份风险仍待闭合，详见 [混合队列记录](p2-mixed-queue.md)。CPU 超预算继续暂缓，test/生产未变更。

最新发布（2026-10-15）：历史 EXIF 尺寸安全修复和单调资产同步版本，代码 `e1ef50d`，dev Worker `29cbfe9d-8886-43bb-9c1b-bd836b6f3dbe`，D1 已迁移 0009。54 项回归通过，公网检查 6 张、实际修复 0 张（均已正确）；详见 [历史修复记录](p2-exif-repair.md)。CPU 问题继续暂缓，test/生产未变更。

最新发布（2026-10-15）：新上传 JPEG/PNG 的 EXIF 方向解析与布局尺寸修正，代码 `95f56d9`，dev 版本 `03aaa260-478e-4bab-baa7-5f65dada1e5c`。49 项回归和公网方向 6 尺寸/字节/Sync/ACK 验证通过，真机渲染仍待验收，见 [EXIF 记录](p2-exif-orientation.md)。无数据库迁移，CPU 超预算继续暂缓。

最新发布（2026-10-15）：PNG CRC 完整性校验，代码 `a94aa0c`，dev 版本 `afc89df4-f7a2-4b01-bd64-1f454b3e652a`。47 项回归及公网损坏/超限拒绝、后续同步检查通过；见 [P2 上传矩阵](p2-upload-matrix.md)。无数据库迁移；CPU 超预算暂缓，test/生产未变更。

最新发布（2026-10-14）：私有媒体 Range、HEAD 与 ETag 条件读取，代码 `7180022`，dev 版本 `090b3506-673a-40d3-8d56-951f97f91159`。45 项回归和公网媒体字节/权限检查通过，见 [P2 媒体记录](p2-media-http.md)。数据库无迁移；CPU 超预算暂缓，test/生产未更改。

最新发布（2026-10-14）：重置快照跳过无用检查点读取并批量登记投递，代码 `06cb163`，dev 版本 `8e036342-096a-42a1-acc4-6d84996bc1bc`。44 项回归、公网 21 步检查通过；CPU 多次采样仍有超预算，见 [重置快照 CPU 记录](p2-reset-cpu.md)。通过 cloudflare-api 仅替换构建内容，配置和数据库不变。

最新更新（2026-10-14）：同步检查点单次读取优化已发布，代码提交 `ca70495`，Worker 版本 `57a5f646-8808-4da7-a91d-a94670eb9cc4`，数据库保持 0008。42 项回归与公网 13 步检查通过；CPU 实测仍未通过 Free 门槛，密码算法和安全参数不变，详见 [安全认证与同步 CPU 评估](p2-auth-sync-cpu.md)。test、生产未发布。下文保留历史记录。

2026-10-14 已通过 cloudflare-api 开启 P1 dev 入口；最新部署与验证见[三环境说明](environments.md)。下文为首次骨架部署的历史记录。

首次部署日期：2026-10-13（Asia/Shanghai）。

## 部署方式与范围

用户最初指定 cloudflare-api，但该 MCP 连接未加载到当前会话；经用户选择，改用 Wrangler 调用 Cloudflare API。OAuth 登录已恢复。仅创建和部署 dev 资源，生产、staging 和账户中其他项目未作更改。

当前部署为初始骨架：没有登录、上传或 Sync V2 实现，不能作为实际照片备份服务使用。

## 资源

| 类型           | 名称 / 标识                                         |
| -------------- | --------------------------------------------------- |
| Worker         | `immich-cf-api-dev`                                 |
| 访问地址       | <https://immich-cf-api-dev.fun.workers.dev>         |
| 健康检查       | <https://immich-cf-api-dev.fun.workers.dev/healthz> |
| Worker 版本 ID | `444c59f0-36ff-43af-a9a0-53e9d989dc7f`              |
| D1             | `immich-cf-db-dev`                                  |
| D1 ID          | `a8754a88-bb89-4d30-af2a-e19a793b253e`              |
| D1 创建区域    | APAC                                                |
| D1 Binding     | `IMMICH_CF_DB`                                      |
| R2             | `immich-cf-media-dev`，Standard                     |
| R2 Binding     | `IMMICH_CF_MEDIA`                                   |
| 环境变量       | `APP_ENV=development`、`APP_VERSION=0.1.0`          |

## 已验证结果

- `pnpm check`：格式、静态检查、类型检查、4 项本地运行时/存储测试、dry-run 构建均通过。
- 远程 D1 迁移 `0001_project_metadata.sql` 已应用；实际查询返回 `project_name=immich-cf`。
- Worker 发布成功，部署输出确认 D1/R2 绑定及环境变量。
- 公网 `GET /healthz` 返回 200，响应为 `{"service":"immich-cf","status":"ok","version":"0.1.0","stage":"scaffold"}`，缓存策略为 `no-store`。
- 公网 `POST /api/assets` 返回 501 和明确的未实现消息，不产生伪上传成功。
- R2 的 `r2.dev` 公开访问为 disabled。未上传任何真实照片。

本次没有进行远程 R2 对象读写测试，也没有进行官方 App、Free CPU 上限或完整 Sync 验收；本地测试通过不替代这些后续阶段验证。

## 再次发布

```sh
pnpm exec wrangler whoami
pnpm check
pnpm db:migrate:dev
pnpm deploy:dev
```

发布后复查 `/healthz`、迁移状态及新的版本 ID。所有命令均以配置中的 dev 资源为目标，不重复创建同名资源。登录失效时运行 `pnpm exec wrangler login` 并在官方页面完成授权；令牌留在 Wrangler 用户配置中，不提交到仓库。
