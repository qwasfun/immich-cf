import type { Identity } from './auth';
import { HttpError, invalid } from './http';

// Internal bounded D1 history compaction. No bucket or original deletion capability.
export async function compactHistory(
  db: D1Database,
  identity: Identity,
  input: Record<string, unknown>,
) {
  const { jobId, cutoff, limit = 100 } = input;
  if (typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(jobId))
    invalid('jobId', '请提供有效任务 UUID，重试使用同一任务 ID');
  if (
    typeof cutoff !== 'string' ||
    !Number.isFinite(Date.parse(cutoff)) ||
    new Date(cutoff).toISOString() !== cutoff ||
    Date.parse(cutoff) > Date.now() - 30 * 86400000
  )
    invalid('cutoff', '必须为至少 30 天前的 UTC ISO 时间，不允许提前清理近期删除记录');
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
    invalid('limit', '每批须为 1～100 项');
  const sessionPredicate = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)`;
  const sessionArgs = [identity.session_id, identity.id, Date.now()];
  await db
    .prepare(
      `INSERT INTO history_cleanup_jobs(id,owner_id,cutoff) SELECT ?,?,? WHERE ${sessionPredicate} ON CONFLICT(id) DO NOTHING`,
    )
    .bind(jobId, identity.id, cutoff, ...sessionArgs)
    .run();
  const job = await db
    .prepare(
      `SELECT cursor,status,cutoff FROM history_cleanup_jobs WHERE id=? AND owner_id=? AND ${sessionPredicate}`,
    )
    .bind(jobId, identity.id, ...sessionArgs)
    .first<{ cursor: number; status: string; cutoff: string }>();
  if (!job) throw new HttpError(404, '清理任务不存在或当前会话无权操作');
  if (job.cutoff !== cutoff)
    throw new HttpError(409, 'cutoff：同一任务的截止时间不可变，请使用原时间重试');
  if (job.status === 'done') return { jobId, processed: 0, done: true };
  const selected = await db
    .prepare(
      `SELECT sync_seq FROM (SELECT sync_seq,deleted_at FROM asset_tombstones WHERE owner_id=?
      UNION ALL SELECT sync_seq,deleted_at FROM asset_metadata_tombstones WHERE owner_id=?) WHERE sync_seq>? AND deleted_at<? ORDER BY sync_seq LIMIT ?`,
    )
    .bind(identity.id, identity.id, job.cursor, cutoff, limit)
    .all<{ sync_seq: number }>();
  const next = selected.results.at(-1)?.sync_seq ?? job.cursor,
    done = selected.results.length < (limit as number);
  const guard = `EXISTS(SELECT 1 FROM history_cleanup_jobs WHERE id=? AND owner_id=? AND cursor=? AND status='running') AND ${sessionPredicate}`;
  const args = [jobId, identity.id, job.cursor, ...sessionArgs];
  const result = await db.batch([
    db
      .prepare(
        `DELETE FROM asset_tombstones WHERE owner_id=? AND sync_seq>? AND sync_seq<=? AND deleted_at<? AND ${guard}`,
      )
      .bind(identity.id, job.cursor, next, cutoff, ...args),
    db
      .prepare(
        `DELETE FROM asset_metadata_tombstones WHERE owner_id=? AND sync_seq>? AND sync_seq<=? AND deleted_at<? AND ${guard}`,
      )
      .bind(identity.id, job.cursor, next, cutoff, ...args),
    db
      .prepare(
        `INSERT INTO asset_history_floor(owner_id,min_seq) SELECT ?,? WHERE ?>0 AND ${guard} ON CONFLICT(owner_id) DO UPDATE SET min_seq=MAX(min_seq,excluded.min_seq)`,
      )
      .bind(identity.id, next, next, ...args),
    db
      .prepare(`UPDATE history_cleanup_jobs SET cursor=?,status=? WHERE id=? AND ${guard}`)
      .bind(next, done ? 'done' : 'running', jobId, ...args),
  ]);
  if (!result[3]!.meta.changes)
    throw new HttpError(409, '清理任务或会话已改变，请用同一任务 ID 重试');
  return { jobId, processed: result[0]!.meta.changes + result[1]!.meta.changes, done };
}
