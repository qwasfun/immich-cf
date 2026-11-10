import { makeZip, predictLength } from 'client-zip';
import { authenticate, type Identity } from '../poc/auth';
import { body, HttpError } from '../poc/http';
import { originalMatches } from '../poc/integrity';
import {
  ArchivePlanner,
  ARCHIVE_BYTES,
  ARCHIVE_FILES,
  DOWNLOAD_TTL,
  safeArchiveName,
} from './archive-plan';
import type { ArchiveEntry } from './archive-plan';
import { field, only, sameOrigin, uuid } from './common';

interface PhotoRow {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  file_created_at: string;
  live_photo_video_id: string | null;
  video_id: string | null;
  video_bytes: number | null;
  video_owner: string | null;
  video_deleted: string | null;
  deleted_at: string | null;
}
interface FileRow {
  id: string;
  object_key: string;
  bytes: number;
  checksum: string;
  r2_sha1_verified: number;
}
interface Job {
  id: string;
  plan_id: string;
  filename: string;
  entries: string;
  revision: string;
  photo_count: number;
  file_count: number;
  total_bytes: number;
  completed_files: number;
  completed_bytes: number;
  state: string;
  error: string;
  run_id: string | null;
  created_ms: number;
  updated_ms: number;
  expires_ms: number;
}
const revisionSql = `SELECT COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=?),0)||':'||COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=?),0) revision`;
const selectedColumns = `a.id,a.filename,a.mime,a.bytes,a.file_created_at,a.live_photo_video_id,a.deleted_at,v.id video_id,v.bytes video_bytes,v.owner_id video_owner,v.deleted_at video_deleted`;
function stale(): never {
  throw new HttpError(409, '照片列表、相册：图库已变化，请关闭面板后重新准备下载', 'ids/albumId');
}
export async function cleanDownloads(db: D1Database) {
  await db
    .prepare(
      'DELETE FROM web_download_jobs WHERE id IN(SELECT id FROM web_download_jobs WHERE expires_ms<=? ORDER BY expires_ms LIMIT 200)',
    )
    .bind(Date.now())
    .run();
}
const publicJob = (job: Job) => ({
  id: job.id,
  filename: job.filename,
  photos: job.photo_count,
  files: job.file_count,
  bytes: job.total_bytes,
  state: job.state,
  completedFiles: job.completed_files,
  completedBytes: job.completed_bytes,
  error: job.error,
  runId: job.run_id,
  expiresAt: new Date(job.expires_ms).toISOString(),
  downloadPath: `/api/immich-cf/web/downloads/${job.id}/archive`,
});
async function getJob(db: D1Database, identity: Identity, id: string): Promise<Job> {
  const job = await db
    .prepare('SELECT * FROM web_download_jobs WHERE id=? AND owner_id=? AND session_id=?')
    .bind(id, identity.id, identity.session_id)
    .first<Job>();
  if (!job)
    throw new HttpError(404, '下载任务：不存在或不属于当前登录，请重新准备下载', 'downloadId');
  if (job.expires_ms <= Date.now())
    throw new HttpError(410, '下载任务：已过期，请关闭面板后重新准备下载', 'downloadId');
  return job;
}

async function prepare(request: Request, db: D1Database, identity: Identity) {
  sameOrigin(request);
  const input = await body(request);
  only(input, ['ids', 'albumId']);
  if ('ids' in input === 'albumId' in input)
    field('ids/albumId', '所选照片、相册', '请只选择一种下载范围');
  const albumId = 'albumId' in input ? uuid(input.albumId, 'albumId') : null;
  let ids: string[] | null = null;
  if (!albumId) {
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 1000)
      field('ids', '所选照片', '请选择 1～1000 张照片后下载');
    ids = input.ids.map((value) => uuid(value, 'ids'));
    if (new Set(ids).size !== ids.length)
      field('ids', '所选照片', '同一照片只能选择一次，请移除重复项目');
  }
  await cleanDownloads(db);
  const planner = new ArchivePlanner(),
    plan = crypto.randomUUID();
  let after = '',
    revision = '',
    name = '所选照片',
    count = 0;
  do {
    const results = await db.batch([
      db.prepare(revisionSql).bind(identity.id, identity.id),
      db
        .prepare(
          `SELECT ${selectedColumns} FROM assets a LEFT JOIN assets v ON v.id=a.live_photo_video_id
        WHERE a.owner_id=? AND a.media_type='IMAGE' AND a.visibility='timeline' AND a.id>?
        ${albumId ? 'AND a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM album_assets l WHERE l.album_id=? AND l.owner_id=a.owner_id AND l.asset_id=a.id)' : 'AND a.id IN(SELECT value FROM json_each(?))'}
        ORDER BY a.id LIMIT 500`,
        )
        .bind(identity.id, after, albumId ?? JSON.stringify(ids)),
      ...(albumId
        ? [
            db
              .prepare('SELECT name FROM albums WHERE id=? AND owner_id=?')
              .bind(albumId, identity.id),
          ]
        : []),
    ]);
    const current = (results[0]!.results[0] as { revision: string }).revision;
    if (revision && current !== revision) stale();
    revision = current;
    if (albumId) {
      const album = results[2]!.results[0] as { name: string } | undefined;
      if (!album) throw new HttpError(404, '相册：不存在或无权访问，请刷新相册列表', 'albumId');
      name = album.name;
    }
    const rows = results[1]!.results as unknown as PhotoRow[];
    if (!rows.length) break;
    for (const row of rows) {
      if (++count > 10000)
        field('albumId', '相册', '每次最多下载 10,000 张照片，请改为分批选择照片');
      if (!Number.isSafeInteger(row.bytes) || row.bytes <= 0 || row.bytes > 20_000_000)
        throw new HttpError(409, '照片文件：大小记录异常，请检查原件后重新准备下载', 'ids');
      if (
        row.live_photo_video_id &&
        (row.video_id !== row.live_photo_video_id ||
          row.video_owner !== identity.id ||
          row.video_deleted !== row.deleted_at ||
          !Number.isSafeInteger(row.video_bytes) ||
          !row.video_bytes ||
          row.video_bytes < 0 ||
          row.video_bytes > 64 * 1024 ** 2)
      )
        throw new HttpError(409, '动态照片：配套 MOV 缺失或状态异常，请先补齐同组原件', 'ids');
      planner.add({
        id: row.id,
        filename: row.filename,
        mime: row.mime,
        bytes: row.bytes,
        modified: row.file_created_at,
        motionId: row.live_photo_video_id,
        motionBytes: row.video_bytes ?? 0,
      });
    }
    after = rows.at(-1)!.id;
  } while (true);
  if (ids && count !== ids.length)
    throw new HttpError(404, '所选照片：包含不存在或无权访问的项目，请刷新后重新选择', 'ids');
  if (!count)
    field(
      albumId ? 'albumId' : 'ids',
      albumId ? '相册' : '所选照片',
      '没有可下载的照片，请先添加照片或重新选择',
    );
  const now = Date.now(),
    jobs: Job[] = planner.parts.map((part, index) => ({
      id: crypto.randomUUID(),
      plan_id: plan,
      filename: `${safeArchiveName(name)}${planner.parts.length > 1 ? `-${String(index + 1).padStart(3, '0')}of${String(planner.parts.length).padStart(3, '0')}` : ''}.zip`,
      entries: JSON.stringify(part.entries),
      revision,
      photo_count: part.photos,
      file_count: part.entries.length,
      total_bytes: part.bytes,
      state: 'queued',
      completed_files: 0,
      completed_bytes: 0,
      error: '',
      run_id: null,
      created_ms: now,
      updated_ms: now,
      expires_ms: now + DOWNLOAD_TTL,
    }));
  try {
    for (let at = 0; at < jobs.length; at += 50)
      await db.batch(
        jobs
          .slice(at, at + 50)
          .map((job) =>
            db
              .prepare(
                `INSERT INTO web_download_jobs(id,plan_id,owner_id,session_id,filename,entries,revision,photo_count,file_count,total_bytes,created_ms,updated_ms,expires_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                job.id,
                plan,
                identity.id,
                identity.session_id,
                job.filename,
                job.entries,
                revision,
                job.photo_count,
                job.file_count,
                job.total_bytes,
                now,
                now,
                job.expires_ms,
              ),
          ),
      );
    await authenticate(request, db);
    if (
      (await db.prepare(revisionSql).bind(identity.id, identity.id).first<{ revision: string }>())!
        .revision !== revision
    )
      stale();
  } catch (error) {
    await db
      .prepare('DELETE FROM web_download_jobs WHERE plan_id=? AND owner_id=?')
      .bind(plan, identity.id)
      .run();
    if (String(error).includes('DOWNLOAD_QUEUE_LIMIT'))
      throw new HttpError(
        429,
        '下载任务：24 小时内生成的分包已达 2000 个，请使用已有任务或等任务过期后重新准备',
        'downloadId',
      );
    throw error;
  }
  return Response.json({
    title: name,
    photos: count,
    files: jobs.reduce((n, j) => n + j.file_count, 0),
    bytes: jobs.reduce((n, j) => n + j.total_bytes, 0),
    limits: { partBytes: ARCHIVE_BYTES, partFiles: ARCHIVE_FILES },
    parts: jobs.map(publicJob),
  });
}

async function archive(
  request: Request,
  env: Env,
  identity: Identity,
  job: Job,
  ctx?: ExecutionContext,
) {
  const db = env.IMMICH_CF_DB,
    query = new URL(request.url).searchParams;
  for (const key of query.keys())
    if (key !== 'attempt') field(key, '下载参数', '仅接受 attempt，请移除其他参数');
  const attempt = uuid(query.get('attempt'), 'attempt');
  if (query.getAll('attempt').length !== 1)
    field('attempt', '下载尝试', '请只提供一个有效尝试标识');
  const claim = await db
    .prepare(
      `UPDATE web_download_jobs SET state='running',run_id=?,completed_files=0,completed_bytes=0,error='',updated_ms=?
    WHERE id=? AND owner_id=? AND session_id=? AND (state<>'running' OR updated_ms<?)`,
    )
    .bind(attempt, Date.now(), job.id, identity.id, identity.session_id, Date.now() - 5 * 60 * 1000)
    .run();
  if (!claim.meta.changes)
    throw new HttpError(409, '下载任务：正在传输，请等待完成或取消后重试', 'downloadId');
  async function guard() {
    const state = await db
      .prepare(
        `SELECT j.state,j.run_id,j.expires_ms,
      EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=j.session_id AND s.user_id=j.owner_id AND u.disabled=0 AND s.expires_at>?) authorized,
      COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=j.owner_id),0)||':'||COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=j.owner_id),0) revision
      FROM web_download_jobs j WHERE j.id=? AND j.owner_id=? AND j.session_id=?`,
      )
      .bind(Date.now(), job.id, identity.id, identity.session_id)
      .first<{
        state: string;
        run_id: string;
        expires_ms: number;
        authorized: number;
        revision: string;
      }>();
    if (!state || !state.authorized) throw new HttpError(401, '会话已失效，请重新登录');
    if (state.run_id !== attempt || state.state !== 'running')
      throw new HttpError(409, '下载任务：已停止或被新的下载替代，请重新准备', 'downloadId');
    if (state.expires_ms <= Date.now())
      throw new HttpError(410, '下载任务：已过期，请重新准备', 'downloadId');
    if (state.revision !== job.revision) stale();
  }
  const fail = async (error: unknown) => {
    const message =
      error instanceof HttpError
        ? error.message
        : '下载传输未完成，请检查网络后重新下载该 ZIP；请勿使用不完整文件';
    await db
      .prepare(
        `UPDATE web_download_jobs SET state='failed',error=?,updated_ms=? WHERE id=? AND run_id=? AND state='running'`,
      )
      .bind(message, Date.now(), job.id, attempt)
      .run();
  };
  const entries = JSON.parse(job.entries) as ArchiveEntry[];
  let release: (() => Promise<void>) | null = null,
    completed = 0,
    completedBytes = 0;
  const cleanup = async () => {
    const close = release;
    release = null;
    await close?.();
  };
  const background = (operation: Promise<unknown>) => {
    if (ctx) ctx.waitUntil(operation.catch(() => undefined));
    else void operation.catch(() => undefined);
  };
  try {
    await guard();
    const files = await db
      .prepare(
        `SELECT id,object_key,bytes,checksum,r2_sha1_verified FROM assets WHERE owner_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?))`,
      )
      .bind(identity.id, job.entries)
      .all<FileRow>();
    if (files.results.length !== entries.length)
      throw new HttpError(409, '照片文件：已有原件删除，请重新准备下载', 'ids');
    const byId = new Map(files.results.map((file) => [file.id, file]));
    async function open(entry: ArchiveEntry) {
      await guard();
      const file = byId.get(entry.id)!;
      const object = await env.IMMICH_CF_MEDIA.get(file.object_key);
      if (!object)
        throw new HttpError(
          503,
          `照片文件：${entry.name} 的原件暂不可读取，请保留本机原件并重新上传后重试`,
          'ids',
        );
      if (
        entry.size !== file.bytes ||
        !originalMatches(object, file.bytes, file.checksum, !!file.r2_sha1_verified)
      ) {
        await object.body.cancel();
        throw new HttpError(
          503,
          `照片文件：${entry.name} 的大小或校验不符，请重新上传同一原件后重试`,
          'ids',
        );
      }
      const reader = object.body.getReader(),
        digest = new crypto.DigestStream('SHA-1'),
        writer = digest.getWriter();
      void digest.digest.catch(() => undefined);
      let read = 0,
        ended = false;
      release = async () => {
        if (!ended) {
          ended = true;
          await Promise.allSettled([reader.cancel(), writer.abort()]);
        }
      };
      const input = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const next = await reader.read();
              if (!next.done) {
                read += next.value.byteLength;
                if (read > entry.size)
                  throw new HttpError(
                    503,
                    `照片文件：${entry.name} 的原件长度异常，请重新上传后重试`,
                    'ids',
                  );
                await writer.write(next.value);
                controller.enqueue(next.value);
                return;
              }
              await writer.close();
              const hash = btoa(String.fromCharCode(...new Uint8Array(await digest.digest)));
              if (read !== entry.size || hash !== file.checksum)
                throw new HttpError(
                  503,
                  `照片文件：${entry.name} 的原件校验不符，请重新上传后重试`,
                  'ids',
                );
              await guard();
              ended = true;
              reader.releaseLock();
              writer.releaseLock();
              release = null;
              completed++;
              completedBytes += read;
              await db
                .prepare(
                  `UPDATE web_download_jobs SET completed_files=?,completed_bytes=?,updated_ms=? WHERE id=? AND run_id=? AND state='running'`,
                )
                .bind(completed, completedBytes, Date.now(), job.id, attempt)
                .run();
              controller.close();
            } catch (error) {
              await cleanup();
              controller.error(error);
            }
          },
          async cancel() {
            await cleanup();
          },
        },
        { highWaterMark: 0 },
      );
      return { name: entry.name, size: entry.size, lastModified: new Date(entry.modified), input };
    }
    const first = await open(entries[0]!);
    async function* source() {
      try {
        yield first;
        for (const entry of entries.slice(1)) yield await open(entry);
        await guard();
      } finally {
        await cleanup();
      }
    }
    const reader = makeZip(source()).getReader();
    let pending: Uint8Array | null = null;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) {
                await guard();
                const result = await db
                  .prepare(
                    `UPDATE web_download_jobs SET state='complete',updated_ms=? WHERE id=? AND run_id=? AND state='running'`,
                  )
                  .bind(Date.now(), job.id, attempt)
                  .run();
                if (!result.meta.changes)
                  throw new HttpError(409, '下载任务：已停止，请重新下载完整 ZIP', 'downloadId');
                if (pending) controller.enqueue(pending);
                pending = null;
                controller.close();
                reader.releaseLock();
                return;
              }
              const previous = pending;
              pending = next.value;
              if (previous) {
                controller.enqueue(previous);
                return;
              }
            }
          } catch (error) {
            await cleanup();
            await reader.cancel().catch(() => undefined);
            await fail(error).catch(() => undefined);
            controller.error(new Error('ARCHIVE_INCOMPLETE'));
          }
        },
        async cancel() {
          await cleanup();
          await reader.cancel().catch(() => undefined);
          background(
            fail(
              new HttpError(409, '下载已中断，请重新下载该 ZIP；不要使用不完整文件', 'downloadId'),
            ),
          );
        },
      },
      { highWaterMark: 0 },
    );
    const length = predictLength(entries.map((entry) => ({ name: entry.name, size: entry.size })));
    const fixed = new FixedLengthStream(length);
    background(stream.pipeTo(fixed.writable));
    return new Response(fixed.readable, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(length),
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="immich-cf-${job.id}.zip"; filename*=UTF-8''${encodeURIComponent(job.filename).replaceAll("'", '%27')}`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    await cleanup();
    await fail(error).catch(() => undefined);
    throw error;
  }
}

export async function downloads(
  request: Request,
  env: Env,
  identity: Identity,
  id?: string,
  isArchive = false,
  ctx?: ExecutionContext,
) {
  if (!id) {
    if (new URL(request.url).search)
      field('请求参数', '下载范围', '请使用 JSON 请求体提供所选照片或相册');
    return prepare(request, env.IMMICH_CF_DB, identity);
  }
  uuid(id, 'downloadId');
  const job = await getJob(env.IMMICH_CF_DB, identity, id);
  if (isArchive) return archive(request, env, identity, job, ctx);
  if (new URL(request.url).search) field('请求参数', '下载任务', '此接口不接受查询参数，请移除');
  if (request.method === 'DELETE') {
    sameOrigin(request);
    only(await body(request, true), []);
    await env.IMMICH_CF_DB.prepare(
      `UPDATE web_download_jobs SET state='cancelled',error='下载任务已停止，可重新下载该分包',updated_ms=? WHERE id=? AND owner_id=? AND session_id=?`,
    )
      .bind(Date.now(), id, identity.id, identity.session_id)
      .run();
    return new Response(null, { status: 204 });
  }
  await authenticate(request, env.IMMICH_CF_DB);
  return Response.json(publicJob(job));
}
