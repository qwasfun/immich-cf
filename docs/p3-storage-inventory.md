# P3：本机只读存储盘点与清理任务恢复

## 范围

`storageInventory` 是内部只读原语，仅通过隔离测试 Worker 调用。生产入口不接入，没有定时执行、自动清理或远程操作。遵循上一轮 [R2 安全清理](p3-r2-cleanup.md) 的原图/预约保留与永久隔离规则。

补齐 P3-04 的两类观察：R2 中的对象是否仍有 D1 引用；D1 中的未完成清理任务是否仍能在对象已经消失后被找到。既有公开 storageAudit 保持原有载荷与行为，新增摘要预约由此内部盘点覆盖，不改变官方 App。

## 对象分页

输入 `{mode:"objects",after?:cursor}`，mode 默认 objects。R2 prefix 由当前账号生成，不接受用户指定 prefix。每页最多 20 个对象，一次 R2 list 和一次 D1 引用查询，不读取原图内容或执行 HEAD/PUT/delete。只返回当前账号前缀下的键、字节数、引用种类和分类，不返回其他引用账号的身份。

引用查询针对本页键、跨账号检查 assets.object_key、assets.integrity_source_key、retired_assets.object_key、retired_assets.integrity_source_key、upload_intents.object_key、integrity_copy_intents.object_key，并观察 r2_cleanup_claims 状态。

| 分类                       | 含义与后续操作                               |
| -------------------------- | -------------------------------------------- |
| referenced                 | 存在任一已知引用或预约；保留                 |
| retained-original          | 无已知引用的 /original 键；仍保留            |
| retained-unknown           | 不认识的键格式；保留                         |
| unreferenced-copy-observed | 当次未观察到引用的摘要副本；仅为人工复核线索 |
| cleanup-pending            | 已认领但仍观察到对象；可用原 key 恢复任务    |
| cleanup-object-reappeared  | done 后再次观察到字节；可用原 key 重放清理   |

所有响应标记 observationOnly=true、snapshotConsistent=false。R2 list 与 D1 查询之间、不同分页之间都不是一致性快照；活跃写入时不能把一轮分页视为完整库的无遗漏证明。静态状态支持使用同一 cursor 重放；检查完成不授权删除，仍须调用 cleanStorageCopy，由数据库在认领事务中重新核对所有引用。

任一 R2/D1 查询失败或返回越界对象时整页 503，不返回部分 entries 或 nextAfter，不输出内部错误与对象内容；用原分页位置有界重试。不会因观察失败产生清理任务或推进持久清理进度。R2 cursor 仅传递，不写 Git；切换账号或模式须重新从首页开始。

## 待恢复任务分页

输入 `{mode:"pending",after?:previousKey}`。只读 D1，按当前 owner、status=claimed、object_key 排序，每页最多 20 个任务，用第 21 行确定下一页。迁移 0018 增加对应联合索引，避免永久保留的 done 标记增长后全表扫描。

此模式不依赖 R2 列表或对象存在性，所以“删除已生效、确认/状态更新前崩溃”的任务仍可恢复。使用原 key 再执行单对象清理；完成后不再出现在 pending。保留永久清理标记，不删除上传/摘要预约、原图或历史源。done 后晚到写入由 objects 模式识别。

## 验收与边界

新增回归覆盖全部引用种类、摘要预约、45 对象分页与重放、23 个待恢复任务分页、删除后缺失对象恢复、done 后晚到字节、跨账号引用保护、读取失败关闭、字段精确提示和身份隔离。所有对象均为随机隔离状态中的合成数据，不读取私人样本。

本轮不新增生产维护 API、自动候选消费、远程部署或远程迁移。不宣称完成 P3 整体验收：1,000 真实资产、官方 iOS 删除/关系/离线恢复和平台成本仍待验证；CPU 超预算工作继续暂缓。4 MiB、Live Photo 防护、bcrypt 安全性及 reset/ACK 并发隔离不降低。

开发验证中发现本机 D1 对复杂组合查询的限制：初版 CTE/UNION 查询报 too many terms in compound SELECT，而原生 SQLite 可执行。现改为单页 JSON 键集合上的索引 EXISTS 查询，保留全部引用种类；必须以实际 D1 模拟器回归为依据，不能只凭 SQLite 语法测试宣告兼容。

## 本轮验证结果

完整 pnpm check 通过：149 项测试，149 通过、0 失败、0 跳过；格式、lint、类型及 dry-run 构建通过。构建 208.61 KiB / gzip 51.24 KiB。冻结契约 279 个操作 / 53 个来源保持一致。6 项新增专项回归亦独立通过；非空迁移测试确认待恢复查询使用新增联合索引。

第一轮完整回归中对象盘点的 5 项用例因上述 D1 查询限制失败，未绕过失败或缩减引用检查。修复查询、校正合成测试里同一原图兼有 source/upload-intent 引用的断言后，完整重跑通过。未读取私人图片，未修改密码、上传限制、Live Photo 防护或同步协议，未部署/迁移远程资源。

后续本机增加 references 模式：由 D1 引用出发，对缺失对象的摘要预约也能观察；六路有界只读 batch 与每页最多20次HEAD，详见 [读取一致性与恢复](p3-read-consistency.md)。原 objects/pending 行为保持，生产维护入口仍未开放。
