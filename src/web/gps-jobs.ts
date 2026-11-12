import { authenticate, type Identity } from '../poc/auth';
import type { Asset } from '../poc/assets';
import { body, HttpError, invalid } from '../poc/http';
import { photoRecord, photoExifDto } from '../poc/photo-details';
import { mapViews, type MapView } from '../geo';
import { field, only, sameOrigin, uuid } from './common';
import { galleryScope, galleryState, readGalleryState } from './gallery-scope';
import { gpsGuard, gpsMutation, gpsStatus, ownedGpsJob, type GpsJobRow } from './gps-job-store';
import { readPhotoExif } from './photo-extraction';
import type { PhotoExif } from '../photo-info';

const unread = "COALESCE(json_extract(a.photo_metadata,'$.extracted'),0)<>1";
function sourceScope(value: unknown, identity: Identity) {
  if (typeof value !== 'string' || value.length > 3000)
    field('scope', '读取范围', '请从照片地图选择来源和筛选后重新打开');
  const params = new URLSearchParams(value);
  if (params.getAll('mapView').length > 1) invalid('mapView', '位置范围：请只提供一个值');
  const view = params.get('mapView') ?? 'library';
  if (!mapViews.includes(view as MapView))
    invalid('mapView', '位置范围：请选择全部照片、照片、收藏、归档或个人相册');
  const key = params.toString();
  params.delete('mapView');
  if (params.has('view')) invalid('view', '读取范围：请使用位置范围选择来源，请移除 view');
  params.set('view', view);
  return { ...galleryScope(params, identity, []), key };
}
async function plan(db: D1Database, identity: Identity, scope: ReturnType<typeof sourceScope>) {
  const [state, count, album] = await db.batch([
    galleryState(db, identity, scope.album),
    db
      .prepare(`SELECT COUNT(*) n FROM assets a WHERE ${scope.where} AND ${unread}`)
      .bind(...scope.args),
    db.prepare('SELECT name FROM albums WHERE id=? AND owner_id=?').bind(scope.album, identity.id),
  ]);
  const total = (count!.results[0] as { n: number }).n;
  if (total > 10000) field('scope', '读取范围', '每次最多 10,000 张，请缩小来源或筛选范围');
  return {
    count: total,
    version: readGalleryState(state!),
    scope: scope.key,
    sourceName: scope.album
      ? '相册：' + (album!.results[0] as { name: string }).name
      : ({ library: '全部照片（含归档）', photos: '照片', favorites: '收藏', archive: '归档' }[
          scope.view
        ] ?? '照片'),
  };
}
const validGps = (row: Asset) => {
  const value = photoExifDto(row);
  return (
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    Math.abs(value.latitude) <= 90 &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    Math.abs(value.longitude) <= 180
  );
};
async function assetSnapshot(db: D1Database, owner: string, id: string) {
  const [version, rows] = await db.batch([
    db
      .prepare(
        'SELECT COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=?),0) version',
      )
      .bind(owner),
    db
      .prepare(
        "SELECT * FROM assets WHERE id=? AND owner_id=? AND media_type='IMAGE' AND visibility='timeline' AND deleted_at IS NULL",
      )
      .bind(id, owner),
  ]);
  return {
    version: (version!.results[0] as { version: number }).version,
    row: rows!.results[0] as unknown as Asset | undefined,
  };
}
async function finish(
  db: D1Database,
  identity: Identity,
  job: GpsJobRow,
  itemId: string,
  state: 'done' | 'failed' | 'skipped',
  outcome: 'gps' | 'noGps' | null,
  code: string | null,
  message: string | null,
  photo?: { version: number; metadata: string },
) {
  const guard = gpsGuard(db, identity, job.id, 'finish', job.lease),
    now = new Date().toISOString(),
    statements = [guard.start];
  const photoGuard = crypto.randomUUID();
  if (photo)
    statements.push(
      db
        .prepare('INSERT INTO web_photo_guards VALUES(?,?,?,?,?,?)')
        .bind(
          photoGuard,
          identity.id,
          identity.session_id,
          photo.version,
          JSON.stringify([itemId]),
          Date.now(),
        ),
      db
        .prepare('UPDATE assets SET photo_metadata=? WHERE id=? AND owner_id=?')
        .bind(photo.metadata, itemId, identity.id),
      db.prepare('DELETE FROM web_photo_guards WHERE id=?').bind(photoGuard),
    );
  statements.push(
    db
      .prepare(
        "UPDATE web_gps_items SET state=?,outcome=?,code=?,message=?,updated_at=? WHERE job_id=? AND asset_id=? AND state='pending'",
      )
      .bind(state, outcome, code, message, now, job.id, itemId),
    db
      .prepare(
        `UPDATE web_gps_jobs SET state=CASE WHEN pending>0 THEN state ELSE 'complete' END,
      lease=NULL,lease_until=0,current_asset_id=NULL,last_asset_id=?,updated_at=? WHERE id=?`,
      )
      .bind(itemId, now, job.id),
    guard.end,
  );
  await gpsMutation(db, statements);
}
async function step(request: Request, env: Env, identity: Identity, job: GpsJobRow) {
  const db = env.IMMICH_CF_DB;
  if (job.state !== 'running') return;
  const guard = gpsGuard(db, identity, job.id, 'lease'),
    lease = crypto.randomUUID(),
    now = Date.now();
  await gpsMutation(db, [
    guard.start,
    db
      .prepare(
        `UPDATE web_gps_jobs SET lease=?,lease_until=?,current_asset_id=(SELECT asset_id FROM web_gps_items WHERE job_id=? AND state='pending' ORDER BY seq LIMIT 1),updated_at=? WHERE id=?`,
      )
      .bind(lease, now + 120000, job.id, new Date(now).toISOString(), job.id),
    db
      .prepare(
        'UPDATE web_gps_items SET tries=tries+1 WHERE job_id=? AND asset_id=(SELECT current_asset_id FROM web_gps_jobs WHERE id=?)',
      )
      .bind(job.id, job.id),
    guard.end,
  ]);
  job = (await ownedGpsJob(db, identity.id, job.id))!;
  // A cancellation or replacement between acquisition and this read cannot use our old lease.
  if (job.lease !== lease) throw new HttpError(409, '读取任务：状态已变化，请刷新进度', 'jobId');
  if (!job.current_asset_id) {
    const end = gpsGuard(db, identity, job.id, 'finish', lease);
    await gpsMutation(db, [
      end.start,
      db
        .prepare("UPDATE web_gps_jobs SET state='complete',lease=NULL,lease_until=0 WHERE id=?")
        .bind(job.id),
      end.end,
    ]);
    return;
  }
  const id = job.current_asset_id;
  let found = await assetSnapshot(db, identity.id, id);
  if (!found.row || photoRecord(found.row).extracted === true) {
    await finish(
      db,
      identity,
      job,
      id,
      'skipped',
      null,
      'NOT_PENDING',
      '照片：已删除或已由其他操作读取，已跳过',
    );
    return;
  }
  let exif: PhotoExif;
  try {
    exif = await readPhotoExif(env, found.row);
  } catch (error) {
    await authenticate(request, db);
    const message =
      error instanceof HttpError ? error.message : '照片原件：读取中断，请确认网络与原件状态后重试';
    await finish(
      db,
      identity,
      job,
      id,
      'failed',
      null,
      error instanceof HttpError && error.status === 400 ? 'MEDIA_INVALID' : 'ORIGINAL_UNAVAILABLE',
      message,
    );
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    found = await assetSnapshot(db, identity.id, id);
    if (!found.row || photoRecord(found.row).extracted === true) {
      await finish(
        db,
        identity,
        job,
        id,
        'skipped',
        null,
        'NOT_PENDING',
        '照片：已删除或已由其他操作读取，已跳过',
      );
      return;
    }
    const record = photoRecord(found.row);
    record.extracted = true;
    record.source = exif;
    const metadata = JSON.stringify(record),
      located = validGps({ ...found.row, photo_metadata: metadata });
    try {
      await finish(db, identity, job, id, 'done', located ? 'gps' : 'noGps', null, null, {
        version: found.version,
        metadata,
      });
      return;
    } catch (error) {
      if (!(error instanceof HttpError && error.field === 'photoVersion')) throw error;
    }
  }
  await finish(
    db,
    identity,
    job,
    id,
    'failed',
    null,
    'PHOTO_BUSY',
    '照片资料：持续变化，请等待其他编辑结束后重试',
  );
}

export async function gpsJobs(
  request: Request,
  env: Env,
  identity: Identity,
  rawId?: string,
  action?: string,
) {
  const db = env.IMMICH_CF_DB,
    params = new URL(request.url).searchParams;
  if (action === 'preview') {
    const scope = sourceScope(params.toString(), identity),
      result = await plan(db, identity, scope);
    await authenticate(request, db);
    return Response.json(result);
  }
  for (const key of params.keys()) {
    if (request.method !== 'GET' || !rawId || key !== 'failureAfter')
      invalid(key, '读取任务：此参数不受支持，请移除');
    if (params.getAll(key).length !== 1) invalid(key, '读取任务：请只提供一个值');
  }
  const id = rawId ? uuid(rawId, 'jobId') : undefined;
  if (request.method === 'GET') {
    const after = params.get('failureAfter') ?? '0';
    if (!/^\d{1,5}$/.test(after) || Number(after) > 10000)
      field('failureAfter', '失败列表', '请刷新列表后重新加载');
    const job = await ownedGpsJob(db, identity.id, id);
    const result = job ? await gpsStatus(db, identity.id, job.id, Number(after)) : null;
    await authenticate(request, db);
    return Response.json(result);
  }
  sameOrigin(request);
  const input = await body(request);
  if (!id) {
    only(input, ['scope', 'version']);
    const scope = sourceScope(input.scope, identity),
      preview = await plan(db, identity, scope);
    if (typeof input.version !== 'string' || !/^\d{1,16}:\d{1,16}$/.test(input.version))
      field('version', '读取范围版本', '请刷新待处理数量后开始');
    if (input.version !== preview.version)
      throw new HttpError(409, '读取范围：图库已变化，请刷新待处理数量后开始', 'version');
    const jobId = crypto.randomUUID(),
      now = new Date().toISOString(),
      guard = gpsGuard(db, identity, jobId, 'create', null, preview.version);
    await gpsMutation(db, [
      guard.start,
      db
        .prepare("DELETE FROM web_gps_jobs WHERE owner_id=? AND state IN('complete','cancelled')")
        .bind(identity.id),
      db
        .prepare(
          'INSERT INTO web_gps_jobs(id,owner_id,scope,source_name,version,total,pending,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          jobId,
          identity.id,
          scope.key,
          preview.sourceName,
          preview.version,
          preview.count,
          preview.count,
          preview.count ? 'running' : 'complete',
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO web_gps_items(job_id,seq,asset_id,filename,updated_at)
        SELECT ?,ROW_NUMBER() OVER(ORDER BY a.id),a.id,a.filename,? FROM assets a WHERE ${scope.where} AND ${unread}`,
        )
        .bind(jobId, now, ...scope.args),
      guard.end,
    ]);
    await authenticate(request, db);
    return Response.json(await gpsStatus(db, identity.id, jobId), { status: 201 });
  }
  const job = (await ownedGpsJob(db, identity.id, id))!;
  if (action === 'step') {
    only(input, []);
    await step(request, env, identity, job);
  } else {
    only(input, ['action', 'ids']);
    if (!['pause', 'resume', 'cancel', 'retry'].includes(String(input.action)))
      field('action', '任务操作', '请选择暂停、继续、结束或重试失败项目');
    const command = String(input.action),
      guard = gpsGuard(db, identity, id, command),
      statements = [guard.start];
    if (input.ids !== undefined && command !== 'retry')
      field('ids', '失败项目', '只有重试失败时可以指定照片');
    if (command === 'retry') {
      let ids: string[] | null = null;
      if (input.ids !== undefined) {
        if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 1000)
          field('ids', '失败项目', '请选择 1～1000 张失败照片，或重试全部失败');
        ids = input.ids.map((value) => uuid(value, 'ids'));
        if (new Set(ids).size !== ids.length) field('ids', '失败项目', '不能重复，请合并重复项目');
        const count = await db
          .prepare(
            "SELECT COUNT(*) n FROM web_gps_items WHERE job_id=? AND state='failed' AND asset_id IN(SELECT value FROM json_each(?))",
          )
          .bind(id, JSON.stringify(ids))
          .first<{ n: number }>();
        if (count?.n !== ids.length)
          field('ids', '失败项目', '只能重试本任务当前失败的照片，请刷新进度');
      }
      statements.push(
        db
          .prepare(
            `UPDATE web_gps_items SET state='pending',outcome=NULL,code=NULL,message=NULL WHERE job_id=? AND state='failed'${ids ? ' AND asset_id IN(SELECT value FROM json_each(?))' : ''}`,
          )
          .bind(id, ...(ids ? [JSON.stringify(ids)] : [])),
      );
      statements.push(
        db
          .prepare(
            "UPDATE web_gps_jobs SET state=CASE WHEN pending>0 THEN 'running' ELSE state END WHERE id=?",
          )
          .bind(id),
      );
    } else if (command === 'cancel')
      statements.push(
        db
          .prepare(
            "UPDATE web_gps_jobs SET state='cancelled',lease=NULL,lease_until=0,current_asset_id=NULL WHERE id=? AND state IN('running','paused')",
          )
          .bind(id),
      );
    else
      statements.push(
        db
          .prepare(`UPDATE web_gps_jobs SET state=? WHERE id=? AND state=?`)
          .bind(
            command === 'pause' ? 'paused' : 'running',
            id,
            command === 'pause' ? 'running' : 'paused',
          ),
      );
    statements.push(
      db
        .prepare('UPDATE web_gps_jobs SET updated_at=? WHERE id=?')
        .bind(new Date().toISOString(), id),
      guard.end,
    );
    await gpsMutation(db, statements);
  }
  await authenticate(request, db);
  return Response.json(await gpsStatus(db, identity.id, id));
}
