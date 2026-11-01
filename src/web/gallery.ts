import { authenticate, type Identity } from '../poc/auth';
import { assetDetailDto, type Asset, readAsset } from '../poc/assets';
import { HttpError, invalid } from '../poc/http';
import { queuePreviews, readPreview, runPreviews } from '../poc/previews';
import { decode, encode, pageSize, uuid } from './common';

interface Cursor {
  owner: string;
  view: string;
  album: string;
  version: string;
  time: number;
  id: string;
}
interface Row extends Asset {
  sortTime: number;
}
export async function gallery(request: Request, env: Env, identity: Identity) {
  const params = new URL(request.url).searchParams,
    db = env.IMMICH_CF_DB;
  for (const key of params.keys())
    if (!['view', 'albumId', 'cursor', 'limit'].includes(key))
      invalid(key, '此查询参数不受支持，请移除');
  const view = params.get('view') ?? 'photos',
    album = params.has('albumId') ? uuid(params.get('albumId'), 'albumId') : '';
  if (!['photos', 'favorites', 'trash', 'album'].includes(view))
    invalid('view', '请选择全部照片、收藏、回收站或相册');
  if ((view === 'album') !== !!album)
    invalid('view/albumId', '相册视图必须提供相册 ID；其他视图请移除相册 ID');
  const limit = pageSize(params),
    raw = params.get('cursor');
  const cursor = raw ? decode<Cursor>(raw) : null;
  if (raw !== null && !cursor) invalid('cursor', '分页游标无效，请刷新后从第一页重新加载');
  if (
    cursor &&
    (cursor.owner !== identity.id ||
      cursor.view !== view ||
      cursor.album !== album ||
      typeof cursor.version !== 'string' ||
      !/^\d+:\d+$/.test(cursor.version) ||
      !Number.isFinite(cursor.time) ||
      typeof cursor.id !== 'string')
  )
    invalid('cursor', '分页游标不属于当前账号或筛选，请刷新后重试');
  if (cursor) uuid(cursor.id, 'cursor');
  const sort = view === 'trash' ? 'julianday(a.deleted_at)' : 'julianday(a.file_created_at)';
  const where = `a.owner_id=? AND a.media_type='IMAGE' AND a.visibility='timeline' AND a.deleted_at IS ${view === 'trash' ? 'NOT ' : ''}NULL${view === 'favorites' ? ' AND a.favorite=1' : ''}${album ? ' AND EXISTS(SELECT 1 FROM album_assets l WHERE l.album_id=? AND l.asset_id=a.id AND l.owner_id=a.owner_id)' : ''}`;
  const args: (string | number)[] = [identity.id, ...(album ? [album] : [])];
  if (cursor) args.push(cursor.time, cursor.id);
  const results = await db.batch([
    db
      .prepare(
        'SELECT COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=?),0) ar,COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=?),0) br',
      )
      .bind(identity.id, identity.id),
    db
      .prepare(
        `SELECT a.*,${sort} sortTime FROM assets a WHERE ${where}${cursor ? ` AND (${sort},a.id)<(?,?)` : ''} ORDER BY ${sort} DESC,a.id DESC LIMIT ?`,
      )
      .bind(...args, limit + 1),
    ...(album
      ? [db.prepare('SELECT id FROM albums WHERE id=? AND owner_id=?').bind(album, identity.id)]
      : []),
  ]);
  await authenticate(request, db);
  if (album && !results[2]!.results.length)
    throw new HttpError(404, '相册：不存在或无权访问，请刷新相册列表', 'albumId');
  const revision = results[0]!.results[0] as { ar: number; br: number },
    version = `${revision.ar}:${revision.br}`;
  if (cursor && cursor.version !== version)
    throw new HttpError(409, '照片列表：图库已变化，请刷新后从第一页重新加载', 'cursor');
  const rows = results[1]!.results as unknown as Row[],
    page = rows.slice(0, limit),
    last = page.at(-1);
  return Response.json({
    items: page.map((row) => ({
      ...assetDetailDto(row),
      bytes: row.bytes,
      previewPath: `/api/immich-cf/web/assets/${row.id}/preview`,
      downloadPath: `/api/immich-cf/web/assets/${row.id}/download`,
    })),
    version,
    nextCursor:
      rows.length > limit && last
        ? encode({ owner: identity.id, view, album, version, time: last.sortTime, id: last.id })
        : null,
  });
}

export async function webMedia(
  request: Request,
  env: Env,
  identity: Identity,
  id: string,
  action: string,
  ctx?: ExecutionContext,
) {
  uuid(id);
  const params = new URL(request.url).searchParams;
  for (const key of params.keys())
    if (!(action === 'preview' ? ['size'] : ['component']).includes(key))
      invalid(key, '此查询参数不受支持，请移除');
  const row = await env.IMMICH_CF_DB.prepare(
    "SELECT * FROM assets WHERE id=? AND owner_id=? AND media_type='IMAGE' AND visibility='timeline'",
  )
    .bind(id, identity.id)
    .first<Asset>();
  if (!row) throw new HttpError(404, '照片：不存在或无权访问，请刷新图库');
  if (action === 'preview') {
    const size = params.get('size') ?? 'thumbnail';
    if (!['thumbnail', 'preview'].includes(size)) invalid('size', '请选择 thumbnail 或 preview');
    await queuePreviews(env, id);
    // Serve existing derivatives immediately; generation runs independently and is leased/budgeted.
    if (ctx) ctx.waitUntil(runPreviews(env, id).catch(() => undefined));
    else await runPreviews(env, id);
    const result = await readPreview(
      request,
      env,
      id,
      identity.id,
      size === 'thumbnail' ? 256 : 2048,
    );
    await authenticate(request, env.IMMICH_CF_DB);
    if (
      !(await env.IMMICH_CF_DB.prepare('SELECT id FROM assets WHERE id=? AND owner_id=?')
        .bind(id, identity.id)
        .first())
    ) {
      await result.body?.cancel();
      throw new HttpError(404, '照片已永久删除，请刷新图库');
    }
    return result;
  }
  const component = params.get('component') ?? 'photo';
  if (!['photo', 'motion'].includes(component)) invalid('component', '请选择 photo 或 motion');
  if (component === 'motion' && !row.live_photo_video_id)
    throw new HttpError(404, '动态视频：此照片没有已配对的 MOV 原件');
  const result = await readAsset(
    request,
    env,
    identity,
    component === 'motion' ? row.live_photo_video_id! : id,
    'original',
  );
  await authenticate(request, env.IMMICH_CF_DB);
  const extension =
    component === 'motion'
      ? 'mov'
      : row.mime === 'image/heic'
        ? 'heic'
        : row.mime === 'image/png'
          ? 'png'
          : 'jpg';
  result.headers.set(
    'Content-Disposition',
    `attachment; filename="${id}.${extension}"; filename*=UTF-8''${encodeURIComponent(component === 'motion' ? row.filename.replace(/\.[^.]*$/, '') + '.mov' : row.filename).replaceAll("'", '%27')}`,
  );
  return result;
}
