# P2 只读存储对账

补齐 P2-02 上传预约与 R2/D1 对账的诊断入口。它只报告当前账户的记录，不执行删除、预约过期、补写或同步状态修改。

`POST /api/immich-cf/storage-audit` 使用现有会话认证，受实验入口开关控制。首次提交 `{}`，后续提交 `{ "after": "上一页 nextAfter" }`。固定每页最多 20 条当前资产/历史源/预约引用，最多 20 次 R2 HEAD；SQL 多取一条判断后续页，不扫描整个 R2。其他参数（例如 apply）返回可定位字段错误。响应不包含对象路径、文件名、原始摘要或底层异常。

- 资产状态：verified、missing、size-mismatch、checksum-mismatch、checksum-unavailable、unavailable。旧资产无原生摘要也明确显示未验证，不将旧版大小回退当作摘要通过。
- 历史源引用：source 对应 integrity_source_key，使用所属资产 ID 和 retained-original 关系。无原生摘要仅表示未知，不判为损坏；细节见[历史原图引用对账](p2-source-audit.md)。
- 预约关系：pending 或 published-checksum；后者只说明同账户同摘要已有资产，不能据此断定预约对象可删。预约对象存在只报 present-unverified，因为预约不保存完整期望大小。
- pageObjectsVerified 仅表示本页非空且所有条目均获原生摘要证明，不能代替全库验收。unavailable 不是 missing。

D1 查询与多个 R2 HEAD、分页之间不是一致性快照，响应固定 observationOnly:true、snapshotConsistent:false。并发上传可能改变观察结果；分页期间插入到游标前的记录可能需下一轮重新检查。对象不存在也可能是尚未写完的预约，绝不能自动清理。未引用的全桶对象不在本次检查范围；自动清理仍待后续单独设计和验收。

本地回归覆盖跨发布者冗余预约、未完成预约、21 条跨页不重不漏、账户隔离、数据库/对象只读、原图损坏和缺失、历史无摘要、R2 HEAD 不可用，以及重传恢复。认证算法、密码参数、官方 App 与 Sync reset/ACK 不变。

公网复测：`node scripts/storage-audit-probe.mjs`，复用 curl、TLS 1.2 和本机代理 127.0.0.1:7890，凭据只从 Git 忽略的 work/dev-account.json 读取。每页只读请求最多 3 次、每次最多 20 秒、总预算 60 秒；不重试 400/401/证书错误。最多 10 页，超限明确失败。报告仅保留状态分类和传输指标；不上传私人照片。它不故意损坏远程对象，故障边界仅在本地隔离资源验证。

CPU 超预算继续暂缓；100 张真实照片、官方 iOS 混合队列以及 G1 仍未完成。

本轮决策：可继续 dev 只读诊断与原有小图实验；不可据对账报告自动删除数据或宣告 P2/G1 完成。发现 missing、摘要异常或 unavailable 时保留手机原件，先确认网络/存储恢复，再重传同一图片并重新核对。published-checksum 的预约保留既有引用，仍不计双份逻辑名额。

## 本轮验证与 dev 发布

2026-10-17：代码提交 `55fbdfd`，dev 版本 `9da964af-5567-460b-9d26-8d9534c2bc45`。通过本机代理由 Wrangler 发布，无待执行迁移，数据库保持 0012。`pnpm check` 91 项测试全部通过、无跳过，格式/lint/类型和 dry-run 通过；冻结契约仍为 279 个操作、53 个来源。构建 196.69 KiB / gzip 48.92 KiB。

公网只读核对 18 条资产：4 条 verified 且 checksumRequired=true；14 条 checksum-unavailable 且 checksumRequired=false，属于历史未升级对象，不能据此认定原图损坏或丢失。本轮没有为升级摘要而上传私人原件，也没有改变旧对象读取策略。临时会话退出 200，无传输错误。见[脱敏对账报告](contracts/p2-storage-audit-probe.json)。

已有上传去重、预检查、原图逐字节读取、Sync/ACK、退出均通过，见[正常链路报告](contracts/p2-storage-audit-bulk-probe.json)。故障、跨页及账户隔离只在本地隔离资源注入验证；公网报告不代表远程异常注入或官方 iOS 实测。

完整 4 MiB 混合 HTTP 队列通过：[最终报告](contracts/p2-storage-audit-mixed-probe.json)、[尝试与进度](contracts/p2-storage-audit-mixed-progress.json)。10 项上传检查、10 次上传尝试、18 次分段原图读取无传输错误，4 张合规图片原图字节一致；Sync/ACK、随后空增量和退出 200。此为合成数据的服务端 HTTP 回归，不替代官方 App 调度、重试真机验收或 100 张真实照片验证。
