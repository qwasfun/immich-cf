# P2 安全认证评估与同步 CPU 优化

日期：2026-10-14。官方 App 不修改；bcrypt cost 12、限流、未知账号等成本校验、会话期限与隔离保持不变。仅 dev 发布同步读取优化，没有迁移密码哈希或引入外部认证账户。

## 认证候选与决策

| 候选                                       | 证据                                                           | 本轮决策                                                               |
| ------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 当前 bcryptjs cost 12                      | 上轮三种登录 CPU 333–386 ms                                    | 不满足 10 ms Free 目标；保留 dev，不降 cost                            |
| WebCrypto PBKDF2-SHA256 600,000 次         | 本地向量一致；线上拒绝超过 100,000 次，返回明确错误            | 当前平台不可用；不改为 100,000，也不自行拼接 KDF                       |
| 原生 scrypt N=32768,r=8,p=3，32 MiB 参数档 | 本地和线上均与 Node 参考向量一致；线上 CPU 227 ms、Wall 228 ms | 超出 Free CPU；不通过                                                  |
| Argon2id/WASM                              | 可评估标准内存/迭代参数，但本轮未引入库或运行线上基准          | 未验证，不以 WASM 更快的推测迁移                                       |
| 外部托管认证（如 Supabase Free）           | 官方有密码认证与 50,000 MAU 免费额度，低活跃免费项目可能暂停   | 仅候选；尚未核实托管哈希参数不低于现有安全强度、迁移及故障语义，不启用 |
| 用户自有认证计算服务                       | 理论上可将昂贵 KDF 移出 Worker，保留原 App 登录接口            | 需要独立可用服务、运维和信任边界，不是纯 Cloudflare 免费方案           |

**当前没有经过验证、同时满足既定安全要求和 Free CPU 的替换方案。** 本次评估没有让账号密码离开 Cloudflare，也没有创建外部平台账户。不得通过快速密码摘要、跨请求认证结果缓存、降低安全参数或修改客户端来掩盖 CPU 问题。托管认证若后续评估通过，应由服务端适配官方登录 DTO，保持本地随机会话与撤销语义，而不是将第三方令牌直接冒充 Immich 会话。

标准参数依据：[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。运行支持依据：[Cloudflare Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)；[workerd PBKDF2 上限变更提案](https://github.com/cloudflare/workerd/pull/7550)不能作为线上已支持的证明。PBKDF2 与 bcrypt 之间不能仅凭迭代数作等价安全比较，本轮没有据此更换存储算法。

外部候选依据：[Supabase 密码认证](https://supabase.com/docs/guides/auth/passwords)、[MAU 配额](https://supabase.com/docs/guides/platform/manage-your-usage/monthly-active-users)、[免费项目暂停](https://supabase.com/docs/guides/platform/free-project-pausing)。这些只证明产品能力和配额，不证明符合本项目安全与可用性要求。

### 探针证据

- `node scripts/kdf-probe.mjs` 启动本地 workerd，仅使用固定公开合成输入，比较 PBKDF2/scrypt 输出与 Node 标准实现；见 [本地报告](contracts/p2-kdf-local.json)。本地支持不代表平台支持。
- 临时 `immich-cf-auth-probe-dev` 使用随机令牌保护、无 D1/R2 绑定，只运行各一个固定合成样本。版本 `629adfa8-6efa-4597-bd5e-a55e8cf79e66`；测量结束后已删除。
- [线上候选报告](contracts/p2-kdf-assessment.json)：scrypt CPU 来自平台 invocation log，并按 CF-Ray/版本关联；PBKDF2 返回 HTTP 200 的探针结果为 supported=false，不能记作 KDF 成功。其 CPU 记录未取到，保留 null，不记为零。
- PBKDF2 的错误为 `iteration counts above 100000 are not supported (requested 600000)`。不根据本地成功覆盖这一线上结果；不把单个 scrypt 样本扩展成延迟分布。

## 同步优化与安全边界

此前同一请求分别为完成标记、AuthUserV2、UserV1、资产、用户元数据查询检查点；现改为一次按当前 session 读取全部检查点，创建请求内 ReadonlyMap，传递给各家族。完整家族请求从最多 5 次检查点查询降至 1 次；预算探针的四家族请求从 4 次降至 1 次。这是检查点查询次数，不是总 D1 查询数或平台 CPU 保证。

不使用跨请求缓存，不删除事务 guard，不提前确认数据。投递登记、reset、ACK、清除仍验证原 epoch 和有效会话；并发重置后旧请求仍应被拒绝。explicit reset 的各家族继续忽略旧游标，用户先于资产、全部资产先于资产元数据的顺序不变。

新增真实 Worker 回归同时检查一次读取、非空快照、ACK 后空增量和用户元数据删除。既有跨会话、旧 ACK、并发 reset、失败回滚与重启恢复矩阵继续运行。

## 验证范围

42 项回归及格式/静态/类型/构建检查已通过。KDF 实验只用于评估，不导入生产入口；没有数据库迁移。官方参考非空图库与 dev 平台 CPU 复测结果见后续记录。G1 仍需认证方案、安全审查、完整资源和客户端矩阵，不能凭同步优化单独通过。

官方冻结容器非空图库对比复跑通过：上传/重复、媒体、未 ACK 重放、部分 ACK、reset 快照及后续空增量均满足硬断言。见 [本轮参考报告](contracts/p2-sync-reference-comparison.json)。原有字段差异未被抹平。

## dev 发布与平台 CPU 复测

代码提交 `ca70495`，发布到 `immich-cf-api-dev`，版本 `57a5f646-8808-4da7-a91d-a94670eb9cc4`。数据库保持 0008，无待应用迁移；test、生产未变更。官方契约校验通过（279 operations、53 sources），官方参考容器完成验证后已停止并保留数据卷。本轮没有新增 iOS 真机验收。

北京时间 2026-10-14 22:14，运行 `scripts/budget-probe.ps1 -IncrementalSamples 5`：健康检查、正确登录、错误密码、未知账号、用户信息、重置快照、ACK、五次空增量、退出共 13 步均符合预期，临时会话已退出。五次增量均仅返回 Complete。

[平台 CPU 报告](contracts/p2-sync-cpu-report.json) 按 CF-Ray、部署版本及响应状态关联调用日志，13 步中取得 10 条 CPU 记录。两次查询均未取得第 1、第 3 次增量和退出记录，保留 null，不视为零或通过。

| 操作                           | 本轮 CPU           | 结论                                        |
| ------------------------------ | ------------------ | ------------------------------------------- |
| 正确登录 / 错误密码 / 未知账号 | 361 / 349 / 471 ms | 保留 bcrypt cost 12，但超过 Free 10 ms 目标 |
| 重置快照                       | 16 ms              | 超过目标                                    |
| ACK                            | 6 ms               | 本次样本在目标内                            |
| 增量第 2 / 4 / 5 次            | 10 / 6 / 9 ms      | 已取样本在目标内；另外两次未知              |
| 用户信息 / 健康检查            | 1 / 0 ms           | 本次样本在目标内                            |

上轮单样本增量为 15 ms、快照为 9 ms；不同运行之间不能据此宣称统计意义上的 CPU 加速。回归确认的是检查点查询最多 5→1；本次快照仍超预算，增量样本少且部分缺失，尚未证明同步 CPU 稳定达标。账户实际套餐仍未核实，HTTP 成功不代表 Free 配额验收通过。

**决策：dev 功能回归通过；当前认证路线及整体 Free CPU 门槛仍为 No-Go，Full Go=false。** 后续需进一步定位快照 CPU，并对外部认证候选的安全参数、会话撤销、迁移、免费可用性和故障恢复进行独立验证，才能决定是否替换认证计算位置；本次不降低密码安全性，也不改变官方 App。
