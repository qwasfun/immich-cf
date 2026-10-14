# P2 dev CPU 预算探针

本轮承接 P1 已完成的有界图片闭环，提前开展 P2-05 资源可行性探针（不代表 P1 全部退出）；不扩展到相册、删除等功能。bcrypt cost 12 保持不变，不以降低安全参数换取免费运行。

## 测量方法

仅 dev 启用 Workers invocation logs，采样率 1；test/prod 不变。平台记录调用元数据；应用不新增密码、令牌或请求体日志。Cloudflare 存储的调用日志与导出的 Git 报告不同，报告仅保留步骤、状态、CPU/Wall 数值等白名单。

运行 `pwsh -File scripts/budget-probe.ps1`，从忽略文件 work/dev-account.json 读取凭据，顺序执行 health、正确/错误密码/未知账号登录、用户信息、非空 reset 快照、ACK、增量、退出。请求 URL 带随机 budgetRun 标记以关联平台日志，不含秘密。只操作新建的临时会话，不重置手机会话；最多三次密码验证，不进行压力攻击。失败也尝试退出，失败记录不得当作成功。

通过 Cloudflare observability telemetry keys/query API 查询指定 Worker 与时间窗口；实际平台将 budgetRun 查询参数脱敏为 REDACTED，因此用响应 CF-Ray 与平台 $metadata.rayId 关联，再核对版本和状态。只提取平台 CPU 时间，禁止用本地计时、HTTP 延迟或 wall time 替代。未取到平台字段必须标为 unverified；工具不把 null/缺失/非数值当成零。CPU 小于阈值的少量样本也不自动提升为完整 Go。

## 当前官方依据

2026-10-14 核对 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)及 [定价](https://developers.cloudflare.com/workers/platform/pricing/)：Free 每次调用 CPU 预算 10 ms。请求延迟包含 I/O，与 CPU 不同。[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)提供平台 invocation CPU/Wall 数据，当前 Free 日志额度 200,000 条/日、保留 3 日；文档已预告 2026-12-01 调整日志计费，需届时复核。

本轮不变更账户付费计划。服务端 usage_model=standard 本身不能证明账户属于 Free；实际账户套餐与资源预算须分开记录。即使当前环境允许成功执行超过 10 ms 的请求，也不能认定 Free 可行。

## 边界

本轮为小样本 CPU 探针，不是 P2 完整预算报告：上传/大图库峰值、D1 行读写、R2 操作与容量、每日总请求、跨地区与冷启动分布、两平台完整验收仍未完成。No-Go 仅针对被证据否定的具体路线；不自动购买付费资源或关闭用户 dev 服务。

## 本次实测与决策

部署提交 `2f42d6a1e38d4bf766192817dfca85e9edc95562`；dev Worker 版本 `66756bfb-184b-462f-886b-8556abbc2d94`，数据库保持 0008。测量窗口为北京时间 2026-10-14 21:41:12–21:41:37，九条记录均匹配同一部署版本与探针响应，平台 outcome 均为 ok。

| 请求         | HTTP | CPU ms | Wall ms |
| ------------ | ---- | ------ | ------- |
| 存活检查     | 200  | 1      | 2       |
| 正确密码登录 | 201  | 366    | 1105    |
| 错误密码登录 | 401  | 386    | 937     |
| 未知账号登录 | 401  | 333    | 878     |
| 当前用户     | 200  | 3      | 186     |
| 非空重置快照 | 200  | 9      | 1460    |
| ACK          | 204  | 3      | 542     |
| 增量同步     | 200  | 15     | 1493    |
| 退出         | 200  | 8      | 383     |

[脱敏平台证据与判定](contracts/p2-budget-report.json)：9/9 条有 CPU 数值，4 条超过 10 ms。三次登录为不同情形各一个样本，不是同一场景的统计分布；增量同步的 15 ms 需要剖析与重复测量，不把其作为长期平均值。

**No-Go：当前 bcryptjs cost 12 在 Worker 内执行的实现不能证明符合 Free CPU 预算，且本次三个密码校验样本明确超出该预算。G1 不通过，不晋升 test/prod。** 请求成功没有改变这一结论。账户订阅 API 返回 Authentication error，套餐未核实；不把样本称为已确认的 Free 环境实测。dev 保留用于有界验证，没有改套餐或弱化密码校验。

下一项先比较安全认证实现/执行位置与预算，随后剖析同步额外 CPU；任何替代方案均须保持官方 App 不修改、密码安全和会话隔离。只有经安全评估并实测通过后，才考虑扩大功能；付费候选须单独决策，不自动启用。

## 结果提取与复现

1. 从 work/budget-probe.json 读取 from/to，查询 `/accounts/{account_id}/workers/observability/telemetry/query`，view=events、dry=true、limit=100，按 `$metadata.service = immich-cf-api-dev` 过滤；时间上界可加 2 秒，等待日志入库后查询。
2. 只从 result.events.events 提取 `$metadata.rayId` 为 requestId，以及 `$workers` 的 scriptName→script、scriptVersion.id→version、cpuTimeMs→cpuMs、wallTimeMs→wallMs、event.response.status→status、outcome。保存为 work/budget-platform.json 的 `{success:true,samples:[...]}`；不要导出原始请求头、完整 URL、IP、账号或令牌。
3. 运行 `node scripts/budget-report.mjs <Worker版本UUID>`。工具按 requestId、script、version、status 精确匹配，重复或缺失事件判为未验证，输出白名单报告到 work/budget-report.json。
4. 报告审核后才复制到 docs/contracts。平台日志保留期有限，历史报告与新测量不能混用。

验证：最终 pnpm check 通过（41 项回归、格式、静态检查、类型检查及构建）；PowerShell 探针语法解析通过，实际九步请求完成且临时会话退出。报告关联测试覆盖错版本、错状态、重复记录、缺失 CPU 与白名单导出。仅 dev 配置已部署，后续报告工具改动不改变 Worker 运行代码。
