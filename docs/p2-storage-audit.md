# P2 只读存储对账

补齐 P2-02 上传预约与 R2/D1 对账的诊断入口。它只报告当前账户的记录，不执行删除、预约过期、补写或同步状态修改。

`POST /api/immich-cf/storage-audit` 使用现有会话认证，受实验入口开关控制。首次提交 `{}`，后续提交 `{ "after": "上一页 nextAfter" }`。固定每页最多 20 条资产/预约，最多 20 次 R2 HEAD；SQL 多取一条判断后续页，不扫描整个 R2。其他参数（例如 apply）返回可定位字段错误。响应不包含对象路径、文件名、原始摘要或底层异常。

- 资产状态：verified、missing、size-mismatch、checksum-mismatch、checksum-unavailable、unavailable。旧资产无原生摘要也明确显示未验证，不将旧版大小回退当作摘要通过。
- 预约关系：pending 或 published-checksum；后者只说明同账户同摘要已有资产，不能据此断定预约对象可删。预约对象存在只报 present-unverified，因为预约不保存完整期望大小。
- pageObjectsVerified 仅表示本页非空且所有条目均获原生摘要证明，不能代替全库验收。unavailable 不是 missing。

D1 查询与多个 R2 HEAD、分页之间不是一致性快照，响应固定 observationOnly:true、snapshotConsistent:false。并发上传可能改变观察结果；分页期间插入到游标前的记录可能需下一轮重新检查。对象不存在也可能是尚未写完的预约，绝不能自动清理。未引用的全桶对象不在本次检查范围；自动清理仍待后续单独设计和验收。

本地回归覆盖跨发布者冗余预约、未完成预约、21 条跨页不重不漏、账户隔离、数据库/对象只读、原图损坏和缺失、历史无摘要、R2 HEAD 不可用，以及重传恢复。认证算法、密码参数、官方 App 与 Sync reset/ACK 不变。

公网复测：`node scripts/storage-audit-probe.mjs`，复用 curl、TLS 1.2 和本机代理 127.0.0.1:7890，凭据只从 Git 忽略的 work/dev-account.json 读取。每页只读请求最多 3 次、每次最多 20 秒、总预算 60 秒；不重试 400/401/证书错误。最多 10 页，超限明确失败。报告仅保留状态分类和传输指标；不上传私人照片。它不故意损坏远程对象，故障边界仅在本地隔离资源验证。

CPU 超预算继续暂缓；100 张真实照片、官方 iOS 混合队列以及 G1 仍未完成。

本轮决策：可继续 dev 只读诊断与原有小图实验；不可据对账报告自动删除数据或宣告 P2/G1 完成。发现 missing、摘要异常或 unavailable 时保留手机原件，先确认网络/存储恢复，再重传同一图片并重新核对。published-checksum 的预约保留既有引用，仍不计双份逻辑名额。
