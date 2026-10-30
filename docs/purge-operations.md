# 永久删除任务：dev 运维恢复

当前计划使用Workers Paid，每5分钟Cron是首选后台续跑路径；客户端活动和本人POST /api/immich-cf/purge-run保留为恢复路径。Cron仅清理已获用户明确永久删除授权的对象，不创建回收站自动到期删除。

## 排查顺序

1. 核对当前dev Worker版本、调度配置与scheduled事件；注册成功和实际运行分别验证。触发器传播最多可能15分钟，见[官方说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
2. 通过本人GET /api/immich-cf/purge-status查看queued、blocked、done；此入口不返回对象键。存在分页时依次使用nextAfter。
3. queued遇到存储/数据库故障会等待下轮；本人POST /api/immich-cf/purge-run可有界重跑。每次最多3项，不用无上限循环；间歇网络失败复用curl有界重试。
4. blocked表示引用检查未获安全隔离。只读核对活动资产、其他退役、上传预约、其他资产复制预约；保留对象和预约，记录冲突供进一步处理。不要为清空任务计数直接删引用、预约或隔离记录。
5. done表示最近一次delete/head确认。对账区分永久授权删除与意外缺失；后台仍按到期时间有界复查迟到字节。

## 控制面只读核对

在确认数据库是immich-cf-db-dev后，可用现有Cloudflare连接查询下列汇总。不要将账户凭据、真实对象键或私人文件名写入Git或公开报告。

```sql
SELECT status, COUNT(*) AS total
FROM asset_purge_jobs GROUP BY status;

SELECT status, COUNT(*) AS total
FROM asset_purge_objects GROUP BY status;

SELECT COUNT(*) AS unfinished_due
FROM asset_purge_jobs
WHERE status <> 'done'
  AND next_check_ms <= CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
```

## 崩溃与回滚

D1逻辑删除事务先持久化任务/候选，再退役资产。提交响应丢失后重放原永久删除请求，不能用恢复照片代替清理恢复。R2删除后状态写入失败时重复删除安全；引用隔离与退役快照不能撤回，以免迟到写入重新发布旧ID。

暂停Cron或关闭实验入口只暂停消费，不删除授权、对象候选、隔离、退役或关系删除历史。恢复Worker时保持0022/0023迁移兼容；回滚代码不回滚不可逆永久删除。数据库导出与隔离恢复演练属于后续P5任务，本手册不等同于备份验收。

只有独立测试账号的合成资产可用于人工故障状态演练；先确认该资产已永久授权、没有活动记录、无会话且账号禁用，保留审计记录。对真实用户照片不做直接SQL状态演练。
