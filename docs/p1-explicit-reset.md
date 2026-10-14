# P1 显式 reset 快照与并发隔离

日期：2026-10-14。范围：官方 Immich 3.3.1 不修改客户端，修正 `POST /api/sync/stream` 的 `reset:true` 行为；仅发布 dev。

## 契约与实现

冻结提交 `db6e11ecc851228aec9c525abb0ee026d1f5055e` 的 `SyncService.streamInternal` 在显式 reset 时先调用 `SessionRepository.resetSyncProgress`；后者在事务内清除检查点并解除 pending 状态。因此本次请求直接返回请求家族的新快照，以 `SyncCompleteV1` 结束，不需要先确认 `SyncResetV1`。本地冻结源码与真实参考环境分别用于语义核对和 HTTP 验证。

- 显式 reset 忽略旧游标，生成当前支持范围的快照；仍遵循 types 过滤和用户先于资产的顺序。
- 同一个 D1 batch 校验原轮次与会话有效性、删除旧检查点及投递、切换随机 epoch、解除 pending/reset ACK 状态、登记新快照投递。任一步失败，全部回滚；流仅在该事务成功后返回。
- 旧 ACK/旧流/旧清除/并发 reset 若持有旧 epoch，事务拒绝 409；之后重新提交失效 ACK 返回字段 `acks` 的具体错误 400。新快照 ACK 正常推进，重复确认不重复插入资产。
- 服务端因检查点过期主动要求重置时，仍使用 `SyncResetV1` 与独立 ACK 流程；显式 reset 可以直接接管待重置会话，旧控制 ACK 不得清空新快照进度。
- 响应丢失或读取中断后，未确认数据可通过普通同步重新拉取；再次显式 reset 会开启新轮次并重放快照。客户端没有重试标识，不能把多次 reset 合并为同一次；旧轮次 ACK 必须拒绝。

迁移 `0008_sync_explicit_reset.sql` 仅调整同步 guard 触发器，不删除用户或媒体。新增 reset-snapshot 操作允许接管 pending，仍受会话、有效期与 epoch 约束；reset ACK 的跨轮次错误分类不再依赖触发器执行顺序。

## 回归矩阵

| 场景                                             | 预期                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| 已确认用户、图片、用户元数据后的显式 reset       | 同一响应重放快照并 Complete，无 Reset 控制事件 |
| reset 快照 ACK 后普通同步                        | 仅 Complete                                    |
| 重复 reset、旧轮次和其它会话 ACK                 | 不接受过期/越界投递                            |
| 旧 ACK/流/清除/reset 暂停，新 reset 先提交       | 旧事务 409，新检查点不变                       |
| 旧 ACK 先提交，已开始的 reset 后提交             | reset 仍发完整快照，忽略旧游标                 |
| pending 控制流和 reset ACK 暂停，显式 reset 接管 | 两个旧请求拒绝，不清除新进度                   |
| 新快照登记触发数据库故障                         | 轮次、检查点及旧投递全部回滚                   |
| 事务已提交但响应丢失，重启进程                   | 普通同步重放未确认快照，可 ACK 恢复增量        |
| types 子集或无效 reset/types 字段                | 正确过滤；无效输入 400 且检查点不变            |
| 既有过期重置、重复控制 ACK、撤销与会话过期       | 保持原隔离与恢复行为                           |

## 边界与后续

ACK 继续携带服务器 epoch；它是不透明确认值，不能假定与官方字符串逐字相同。参考环境仍存在用户可见范围、默认值、有限会话期限等记录在案的差异。本轮不宣称所有 Sync 家族、非空图库参考对比、官方 Dart 调用轨迹或 Free CPU 已验收；iOS 真机需要重新验证。

真机步骤：保持官方 3.3.1 build 23 连接 dev，确认现有图片和预览正常；执行同步重置后刷新，检查图片无重复且预览正常；同步中短暂断网后恢复，再重启 App，确认能继续同步。失败时提供操作时间、日志及是否出现缺图/重复图。服务端测试会直接发送 reset:true，真机菜单操作本身不作为实际请求字段的证明。

## 本地与官方参考验证

- `pnpm check` 通过：36 项回归、格式、静态检查、类型检查与构建；`pnpm contracts:verify` 通过（279 个操作、53 份既有来源）。
- 新迁移通过真实 Wrangler D1 本地迁移路径，未使用自定义 SQL 分割器代替发布验证。
- 冻结官方容器及本地 immich-cf 均通过显式 reset 直接快照、快照 ACK 204、后续仅 Complete 的硬断言。脱敏证据见 [双端报告](contracts/p1-explicit-reset-comparison.json) 的 `resetRecovery`；源码摘要见 [来源](contracts/p1-explicit-reset-sources.json)。
- 16 项字段投影比较仍为 10 项相同、6 项不同：reset 的控制流程已对齐，但用户可见范围、avatarColor 和 epoch ACK 段数仍使完整 reset 投影不同，不能将其写成逐字段完全一致。历史报告保留原结果。
- 官方参考容器已停止，测试卷保留。本轮没有操作 test/prod，也没有重新执行官方 iOS 真机测试。
