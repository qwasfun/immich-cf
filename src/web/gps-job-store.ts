import type { Identity } from '../poc/auth';
import { HttpError } from '../poc/http';
import type { GpsJob } from '../gps-job-info';

export interface GpsJobRow {
  id: string;
  owner_id: string;
  scope: string;
  source_name: string;
  version: string;
  total: number;
  state: GpsJob['state'];
  lease: string | null;
  lease_until: number;
  current_asset_id: string | null;
  created_at: string;
  updated_at: string;
}
export async function ownedGpsJob(db: D1Database, owner: string, id?: string) {
  const row = await db
    .prepare(`SELECT * FROM web_gps_jobs WHERE owner_id=?${id ? ' AND id=?' : ''}`)
    .bind(owner, ...(id ? [id] : []))
    .first<GpsJobRow>();
  if (!row && id) throw new HttpError(404, '读取任务：不存在或已被新任务替换，请刷新进度', 'jobId');
  return row;
}
export function gpsGuard(
  db: D1Database,
  identity: Identity,
  id: string,
  action: string,
  lease: string | null = null,
  version: string | null = null,
) {
  const guard = crypto.randomUUID();
  return {
    start: db
      .prepare('INSERT INTO web_gps_guards VALUES(?,?,?,?,?,?,?,?)')
      .bind(guard, identity.id, identity.session_id, id, action, lease, version, Date.now()),
    end: db.prepare('DELETE FROM web_gps_guards WHERE id=?').bind(guard),
  };
}
export async function gpsMutation(db: D1Database, statements: D1PreparedStatement[]) {
  try {
    return await db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (/GPS_SESSION|PHOTO_SESSION/.test(message))
      throw new HttpError(401, '登录会话：已失效，请重新登录后继续读取');
    if (message.includes('GPS_VERSION'))
      throw new HttpError(409, '照片范围：图库已变化，请刷新待处理数量后开始', 'version');
    if (/GPS_ACTIVE|UNIQUE constraint failed: web_gps_jobs.owner_id/.test(message))
      throw new HttpError(409, '读取任务：已有未结束任务，请继续或结束原任务后再开始', 'jobId');
    if (message.includes('GPS_JOB'))
      throw new HttpError(404, '读取任务：不存在或已被替换，请刷新进度', 'jobId');
    if (/GPS_BUSY|GPS_LEASE/.test(message))
      throw new HttpError(
        409,
        '读取任务：当前请求仍在处理或任务状态已变化，请刷新进度后继续',
        'jobId',
      );
    if (/PHOTO_VERSION|PHOTO_SCOPE/.test(message))
      throw new HttpError(409, '照片资料：已变化，正在重新核对当前资料', 'photoVersion');
    throw new HttpError(503, '读取任务：提交结果暂不能确认，请先刷新进度再继续', 'jobId');
  }
}
export async function gpsStatus(
  db: D1Database,
  owner: string,
  id: string,
  failureAfter = 0,
): Promise<GpsJob> {
  const [jobs, counts, failures, last] = await db.batch([
    db
      .prepare(
        'SELECT j.*,i.filename current_file FROM web_gps_jobs j LEFT JOIN web_gps_items i ON i.job_id=j.id AND i.asset_id=j.current_asset_id WHERE j.id=? AND j.owner_id=?',
      )
      .bind(id, owner),
    db
      .prepare(
        'SELECT pending,succeeded,located,no_gps noGps,failed,skipped FROM web_gps_jobs WHERE id=? AND owner_id=?',
      )
      .bind(id, owner),
    db
      .prepare(
        `SELECT asset_id id,seq,filename,code,message,tries FROM web_gps_items WHERE job_id=? AND state='failed' AND seq>?
      AND EXISTS(SELECT 1 FROM web_gps_jobs WHERE id=? AND owner_id=?) ORDER BY seq LIMIT 51`,
      )
      .bind(id, failureAfter, id, owner),
    db
      .prepare(
        'SELECT i.filename,i.state,i.message FROM web_gps_jobs j JOIN web_gps_items i ON i.job_id=j.id AND i.asset_id=j.last_asset_id WHERE j.id=? AND j.owner_id=?',
      )
      .bind(id, owner),
  ]);
  const job = jobs!.results[0] as unknown as GpsJobRow & { current_file: string | null };
  if (!job) throw new HttpError(404, '读取任务：不存在或已被替换，请刷新进度', 'jobId');
  const count = counts!.results[0] as unknown as Pick<
    GpsJob,
    'pending' | 'succeeded' | 'located' | 'noGps' | 'failed' | 'skipped'
  >;
  const entries = failures!.results as unknown as GpsJob['failures'];
  return {
    id: job.id,
    scope: job.scope,
    sourceName: job.source_name,
    total: job.total,
    state: job.state,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    ...count,
    processed: count.succeeded + count.failed + count.skipped,
    leaseUntil: job.lease_until,
    currentFile: job.lease_until > Date.now() ? job.current_file : null,
    lastResult: (last!.results[0] as unknown as GpsJob['lastResult']) ?? null,
    failures: entries.slice(0, 50),
    nextFailure: entries.length > 50 ? entries[49]!.seq : null,
  };
}
