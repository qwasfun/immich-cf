# P2 dev CPU 预算探针

本轮承接 P1 已完成的有界图片闭环，提前开展 P2-05 资源可行性探针（不代表 P1 全部退出）；不扩展到相册、删除等功能。bcrypt cost 12 保持不变，不以降低安全参数换取免费运行。

## 测量方法

仅 dev 启用 Workers invocation logs，采样率 1；test/prod 不变。平台记录调用元数据；应用不新增密码、令牌或请求体日志。Cloudflare 存储的调用日志与导出的 Git 报告不同，报告仅保留步骤、状态、CPU/Wall 数值等白名单。

运行 `pwsh -File scripts/budget-probe.ps1`，从忽略文件 work/dev-account.json 读取凭据，顺序执行 health、正确/错误密码/未知账号登录、用户信息、非空 reset 快照、ACK、增量、退出。请求 URL 带随机 budgetRun 标记以关联平台日志，不含秘密。只操作新建的临时会话，不重置手机会话；最多三次密码验证，不进行压力攻击。失败也尝试退出，失败记录不得当作成功。

通过 Cloudflare observability telemetry keys/query API 查询指定 Worker、budgetRun 与时间窗口。只提取平台 CPU 时间，禁止用本地计时、HTTP 延迟或 wall time 替代。未取到平台字段必须标为 unverified；工具不把 null/缺失/非数值当成零。CPU 小于阈值的少量样本也不自动提升为完整 Go。

## 当前官方依据

2026-10-14 核对 [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)及 [定价](https://developers.cloudflare.com/workers/platform/pricing/)：Free 每次调用 CPU 预算 10 ms。请求延迟包含 I/O，与 CPU 不同。[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)提供平台 invocation CPU/Wall 数据，当前 Free 日志额度 200,000 条/日、保留 3 日；文档已预告 2026-12-01 调整日志计费，需届时复核。

本轮不变更账户付费计划。服务端 usage_model=standard 本身不能证明账户属于 Free；实际账户套餐与资源预算须分开记录。即使当前环境允许成功执行超过 10 ms 的请求，也不能认定 Free 可行。

## 边界

本轮为小样本 CPU 探针，不是 P2 完整预算报告：上传/大图库峰值、D1 行读写、R2 操作与容量、每日总请求、跨地区与冷启动分布、两平台完整验收仍未完成。No-Go 仅针对被证据否定的具体路线；不自动购买付费资源或关闭用户 dev 服务。
