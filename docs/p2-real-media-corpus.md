# P2 真实 JPEG/PNG 样本验收工具

本轮交付本机验收工具与回归，不宣称已完成 100 张真实照片。当前默认私人样本清单不存在；合成 JPEG/PNG 只用于验证工具与故障路径，不能充当真实媒体覆盖。CPU 超预算继续暂缓，官方 App、bcrypt cost 12、reset/ACK 并发隔离和 20 张逻辑额度不改动。

## 准备清单

1. 将有权用于测试的非唯一 JPEG/PNG 原件放入 `tests/private-fixtures/real-media/`；该目录已被 Git 忽略。请保留手机原件与独立备份。
2. 复制[清单示例](templates/real-media-manifest.example.json)到该目录的 manifest.json，替换所有示例文件名与尺寸。示例中的两张图片不存在，也不代表用户实际样本。
3. 每项填写 file、provenance、captureId 和 expected。file 为清单目录内的相对路径，不得用绝对路径、..、驱动器/数据流或逃逸链接。provenance 为 user-original（用户声明的原件）或 synthetic-fixture（合成/变体）。同次拍摄的导出版本、格式转换或元数据变体使用相同 captureId；不要填姓名、联系方式或位置。
4. expected.status：201 表示预期支持（实际重复可返回 200），400/413 表示预期拒绝。expected.mime 只允许 image/jpeg 或 image/png；预期支持时必须填写独立确认的布局 width/height，包含 EXIF 方向的宽高交换，不能从本服务输出反填。可从本机图片查看器或独立元数据工具确认，来源仍需人工审阅。

清单限 1～200 条、256 KiB；每个文件 1 字节～8 MiB、全批最多 1 GiB。支持上传范围仍为 4 MiB、既有尺寸/像素与格式限制，验收工具接受较大输入只是为验证拒绝。大于 8 MiB 的超限文件另行测试，不做截断或转码来凑样本。

建议真实样本至少包含 JPEG/PNG、横竖方向、JPEG 基线/渐进、不同编码来源与边界大小。HEIC、视频及 Live Photo 不计 JPEG/PNG 通过样本；源图片含关联标记可能按当前防护拒绝，须在清单中如实记录，不通过去除元数据掩盖风险。

## 本机运行

在 dev 分支、Node 24.9.0 以上的 Node 24 与固定 pnpm 版本下运行：

```powershell
pnpm p2:real-media
# 或显式指定私人清单
pnpm p2:real-media --manifest tests/private-fixtures/real-media/manifest.json
```

工具用随机 work/real-media-* 状态启动生产入口的隔离本地 Worker/D1/R2；迁移固定 --local，getPlatformProxy 禁用远程绑定，Worker forceLocal。新建的虚拟测试用户使用 bcrypt cost 12，密码只保留内存；不读取 dev 登录凭据，不连接远程 dev 存储。不会运行真实服务器的远程迁移或清理。

每批最多 20 条输入，每批独立账户；100 张输入无需提高现有 20 张限制。输入文件在预检后若变更，读取时摘要核对拒绝，避免把两版文件混进同一验收。测试数据只写入隔离状态，不覆盖现有开发数据库。

传输层只允许带端口的 http://127.0.0.1，拒绝公网、localhost、URL 凭据/路径/query。它复用已有 curl 上传有界重试与 Range/ETag 恢复，但本地服务不经过外部代理。公网 dev 发布复测单独使用已验证的 127.0.0.1:7890 代理与合成固定素材；私人真实清单没有公网模式，不能靠传入 URL 将它上传到远程。

## 检查与报告

支持项：上传、立即重试去重、跨条目去重、原图逐字节、当前原图作为预览的字节策略、实际 MIME、Sync 资产集合与布局尺寸、ACK 及随后空增量。预期拒绝项：HTTP 400/413 与清单一致，后续正常条目继续执行，Sync 不出现失败资产。当前不验证像素解码、色彩、真实 iOS 自动队列调度或缩略图生成性能。

只有该批 Sync/ACK 与空增量检查结束后，条目才标为 passed。失败会保留阶段结果并将 complete=false；HTTP 不符时保留服务端具体字段原因，退出失败不覆盖原错误，并记录 cleanupUnconfirmed。工具尝试退出会话并关闭服务/本地绑定；work 下隔离数据库与图片保留供复查，不自动递归删除。

`work/real-media-report.json` 包含结果索引、字节大小、HTTP 状态、脱敏传输指标和汇总；不包含原文件名、路径、原图内容、摘要、captureId、账户或令牌。curl 临时请求/响应文件由既有工具清理。报告只保留最近一次运行，请在需要时自行归档到忽略目录；原始照片和私人清单不得提交 Git。

accepted 是通过的输入条目数（可包含重复），acceptedUniqueContents 为全批去重内容数。declaredRealUniqueContents 按完整 SHA-256 去重，declaredRealUniqueCaptures 按拍摄标识去重；两者均至少 100 且覆盖 JPEG/PNG 才令 declaredRealThresholdMet=true。合成条目、重复字节或同次拍摄变体不能用于凑这两个门槛。

真实来源依赖用户声明，工具不能自动证明真实性，因此 provenanceIndependentlyVerified、fullDecodeVerified、officialAppVerified、g1Passed 始终为 false。即使声明门槛达到，也须人工审阅来源、方向/色彩、真机队列与预算，不能据此宣布 P2/G1 全部完成。

## 本轮工具证据范围

回归使用合成样本，覆盖清单防越界/链接、变化检测、合成/重复统计、公网目标拒绝、21 个独立合成内容跨账户、失败项后继续、尺寸黄金值错误和服务端字段原因保留。独立命令行冒烟使用 PNG、预期拒绝文件、4 MiB 超限 PNG、JPEG 和重复 PNG，共 5 条；它只证明工具可运行，不是 5 张独立真实照片。

不修改线上 Worker 业务逻辑；按既有发布流程将当前 dev 提交构建发布，并用既有合成素材验证正常链路。真实 100 张、官方 App 真机和 CPU/Free 验收继续待补，不能用合成报告代替。

## 本轮本机验证

`pnpm check` 113 项回归通过，无失败或跳过；格式/lint/类型和 dry-run 构建通过。冻结契约仍为 279 个操作、53 个来源。Worker 构建保持 203.29 KiB / gzip 50.17 KiB，本轮业务运行时代码未改动。

CLI 合成清单实际结果为 201 → 400 → 413 → 201 → 200，完整 Sync/ACK、空增量及退出通过；5 条输入、3 条通过输入、2 份独立内容、0 条声明真实样本，declaredRealThresholdMet=false。原图/预览有界 Range 读取与上传使用既有 curl 恢复路径，未出现传输错误。报告仅作为本地工具证明；当前没有真实样本清单，100 张真实照片关口未通过。

## dev 发布与证据

代码 `ba4597e`，dev 版本 `34c435a2-a3f4-4063-9c7e-8d158cd9aa77`，2026-10-17 通过已验证本机代理由 Wrangler 发布，无待执行迁移，D1 保持 0013，test/生产未变更。业务 Worker 构建与上轮一致；新增内容在本机验收工具、测试和文档中。

[本地合成工具实跑报告](contracts/p2-real-media-local-smoke.json)明确 scope=isolated-local-synthetic-tool-smoke、remoteUpload=false 和真实来源门槛未通过。[dev 正常链路报告](contracts/p2-real-media-dev-probe.json)验证上传去重、预检查、原图、Sync/ACK、退出，7 次请求无传输错误，未上传私人清单。私人原件和清单不在发布/提交范围，真实 100 张验收仍等待清单与人工来源复核。

工具上传使用索引文件名与固定测试日期，不验收原始拍摄时间/GPS 映射；原图字节不改写。真实清单准备后运行前述命令，先确认 complete=true，再审阅真实独立内容/拍摄计数和未完成关口。

## 私人样本直连加固

本机样本的 JSON、上传重试、详情与 Range 请求显式设置 curl proxy 为空、noproxy=*，覆盖环境代理；不会修改系统代理。公网脚本的显式代理配置保持原状。新增陷阱代理回归：先确认普通对照请求会进入代理，再确认私人本机上传与 Range 请求的代理命中为 0。

加固后完整 `pnpm check` 114 项通过，无失败或跳过；直连专项单独重跑通过，最新 CLI 的 5 条合成用例再次完整通过。业务 Worker 构建仍为 203.29 KiB / gzip 50.17 KiB；真实样本门槛仍为 false。
