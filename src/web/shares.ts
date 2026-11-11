import { authenticate, type Identity } from '../poc/auth';
import { body, digest, HttpError } from '../poc/http';
import { queuePreviews, readPreview, runPreviews } from '../poc/previews';
import { field, only, pageSize, sameOrigin, uuid } from './common';

type Share = {
  id: string;
  title: string;
  album_id: string | null;
  asset_ids: string | null;
  created_ms: number;
  expires_ms: number;
};

const eligible = "a.media_type='IMAGE' AND a.visibility='timeline' AND a.deleted_at IS NULL";
const sessionValid = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.id=? AND s.user_id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)`;
const columns = 'id,title,album_id,asset_ids,created_ms,expires_ms';
const publicColumns = 's.id,s.title,s.owner_id,s.expires_ms';
const membership = `a.owner_id=s.owner_id AND ${eligible} AND (
  (s.album_id IS NULL AND a.id IN(SELECT value FROM json_each(s.asset_ids))) OR
  (s.album_id IS NOT NULL AND EXISTS(SELECT 1 FROM album_assets l
    WHERE l.album_id=s.album_id AND l.owner_id=s.owner_id AND l.asset_id=a.id)))`;
const active = 's.token_hash=? AND s.expires_ms>? AND u.disabled=0';

function unavailable(): never {
  throw new HttpError(404, '分享链接无效、已过期或已撤销，请向分享者索取新链接');
}
function noQuery(request: Request) {
  if (new URL(request.url).search) field('查询参数', '分享', '此操作不接受查询参数，请移除');
}
function summary(share: Share) {
  return {
    id: share.id,
    title: share.title,
    kind: share.album_id ? 'album' : 'photos',
    photoCount: share.asset_ids ? (JSON.parse(share.asset_ids) as string[]).length : null,
    createdAt: new Date(share.created_ms).toISOString(),
    expiresAt: new Date(share.expires_ms).toISOString(),
  };
}

export async function cleanShares(db: D1Database) {
  await db
    .prepare(
      'DELETE FROM web_shares WHERE id IN(SELECT id FROM web_shares WHERE expires_ms<=? ORDER BY expires_ms LIMIT 200)',
    )
    .bind(Date.now())
    .run();
}

async function createShare(request: Request, db: D1Database, identity: Identity) {
  const input = await body(request);
  only(input, ['albumId', 'ids', 'days']);
  if ('albumId' in input === 'ids' in input)
    field('ids/albumId', '所选照片、相册', '请选择一种分享范围');
  const days = input.days;
  if (days !== 1 && days !== 7 && days !== 30) field('days', '有效期', '请选择 1 天、7 天或 30 天');

  const albumId = 'albumId' in input ? uuid(input.albumId, 'albumId') : null;
  let ids: string[] = [];
  if (!albumId) {
    if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 1000)
      field('ids', '所选照片', '请选择 1～1000 张照片');
    ids = input.ids.map((id) => uuid(id, 'ids'));
    if (new Set(ids).size !== ids.length) field('ids', '所选照片', '请移除重复项目后再分享');
  }

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const id = crypto.randomUUID();
  const tokenHash = await digest(token);
  const now = Date.now();
  const expires = now + days * 86400000;
  const insert =
    'INSERT INTO web_shares(id,owner_id,album_id,asset_ids,token_hash,title,created_ms,expires_ms)';
  const session = [identity.session_id, identity.id, now];
  // Validate the scope and the current session in the same statement as creation.
  const statement = albumId
    ? db
        .prepare(
          `${insert}
      SELECT ?,b.owner_id,b.id,NULL,?,b.name,?,? FROM albums b
      WHERE b.id=? AND b.owner_id=? AND ${sessionValid} AND EXISTS(
        SELECT 1 FROM album_assets l JOIN assets a ON a.id=l.asset_id AND a.owner_id=l.owner_id
        WHERE l.album_id=b.id AND l.owner_id=b.owner_id AND ${eligible})
      RETURNING ${columns}`,
        )
        .bind(id, tokenHash, now, expires, albumId, identity.id, ...session)
    : db
        .prepare(
          `${insert}
      SELECT ?,?,NULL,?,?,'所选照片',?,? WHERE ${sessionValid} AND ?=(
        SELECT COUNT(*) FROM assets a WHERE a.owner_id=? AND ${eligible}
        AND a.id IN(SELECT value FROM json_each(?)))
      RETURNING ${columns}`,
        )
        .bind(
          id,
          identity.id,
          JSON.stringify(ids),
          tokenHash,
          now,
          expires,
          ...session,
          ids.length,
          identity.id,
          JSON.stringify(ids),
        );
  let result: Share | null;
  try {
    result = await statement.first<Share>();
  } catch (error) {
    if (String(error).includes('WEB_SHARE_LIMIT'))
      throw new HttpError(
        429,
        '分享链接：最多保留 100 个有效链接，请先撤销不再使用的链接',
        'shareId',
      );
    throw error;
  }
  if (!result) {
    await authenticate(request, db);
    if (!albumId)
      throw new HttpError(404, '所选照片：部分照片不可分享，请刷新并重新选择未删除的照片', 'ids');
    const album = await db
      .prepare('SELECT id FROM albums WHERE id=? AND owner_id=?')
      .bind(albumId, identity.id)
      .first();
    if (!album) throw new HttpError(404, '相册：不存在或无权访问，请刷新相册列表', 'albumId');
    field('albumId', '相册', '没有可分享的照片，请先添加照片');
  }
  return Response.json({ ...summary(result), path: `/share#${token}` }, { status: 201 });
}

export async function manageShares(
  request: Request,
  db: D1Database,
  identity: Identity,
  id?: string,
) {
  noQuery(request);
  if (request.method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT ${columns} FROM web_shares WHERE owner_id=? AND expires_ms>? ORDER BY created_ms DESC,id`,
      )
      .bind(identity.id, Date.now())
      .all<Share>();
    await authenticate(request, db);
    return Response.json({ items: results.map(summary) });
  }
  sameOrigin(request);
  if (!id) return createShare(request, db, identity);
  uuid(id, 'shareId');
  only(await body(request, true), []);
  const result = await db
    .prepare(`DELETE FROM web_shares WHERE id=? AND owner_id=? AND ${sessionValid}`)
    .bind(id, identity.id, identity.session_id, identity.id, Date.now())
    .run();
  if (!result.meta.changes) {
    await authenticate(request, db);
    throw new HttpError(404, '分享链接：不存在或已撤销，请刷新分享列表', 'shareId');
  }
  return new Response(null, { status: 204 });
}

export async function sharedPhotos(
  request: Request,
  env: Env,
  id?: string,
  ctx?: ExecutionContext,
) {
  const authorization = request.headers.get('authorization');
  const token = authorization?.match(/^Share ([a-f0-9]{64})$/)?.[1];
  if (!token) unavailable();
  const hash = await digest(token);
  const db = env.IMMICH_CF_DB;
  const query = new URL(request.url).searchParams;
  const joined = 'FROM web_shares s JOIN users u ON u.id=s.owner_id';
  if (id) {
    const assetId = uuid(id);
    for (const key of query.keys())
      if (key !== 'size') field('size', '预览尺寸', '请移除多余的查询参数');
    const size = query.get('size') ?? 'thumbnail';
    if (query.getAll('size').length > 1 || (size !== 'thumbnail' && size !== 'preview'))
      field('size', '预览尺寸', '请选择 thumbnail 或 preview');
    const check = () =>
      db
        .prepare(
          `SELECT s.owner_id ${joined} JOIN assets a ON a.id=? AND ${membership} WHERE ${active}`,
        )
        .bind(assetId, hash, Date.now())
        .first<{ owner_id: string }>();
    const share = await check();
    if (!share) unavailable();
    await queuePreviews(env, assetId);
    const preview = runPreviews(env, assetId);
    if (ctx) ctx.waitUntil(preview.catch(() => undefined));
    else await preview;
    let result: Response;
    try {
      result = await readPreview(
        request,
        env,
        assetId,
        share.owner_id,
        size === 'preview' ? 2048 : 256,
      );
    } catch (error) {
      if (!(await check())) unavailable();
      if (error instanceof HttpError && error.status === 503)
        throw new HttpError(503, '照片预览暂不可用，请稍后重试');
      throw error;
    }
    if (!(await check())) {
      await result.body?.cancel();
      unavailable();
    }
    result.headers.delete('ETag');
    return result;
  }
  for (const key of query.keys())
    if (!['cursor', 'limit'].includes(key) || query.getAll(key).length !== 1)
      field('cursor', '分页', '仅接受单个 cursor 和 limit 参数，请刷新后重试');
  const limit = pageSize(query);
  const cursor = query.has('cursor') ? uuid(query.get('cursor'), 'cursor') : '';
  const now = Date.now();
  const [grants, photos] = await db.batch([
    db.prepare(`SELECT ${publicColumns} ${joined} WHERE ${active}`).bind(hash, now),
    db
      .prepare(
        `SELECT a.id ${joined} JOIN assets a ON ${membership}
      WHERE ${active} AND a.id>? ORDER BY a.id LIMIT ?`,
      )
      .bind(hash, now, cursor, limit + 1),
  ]);
  const share = grants?.results[0] as { title: string; expires_ms: number } | undefined;
  if (!share) unavailable();
  const items = (photos?.results ?? []).slice(0, limit) as { id: string }[];
  return Response.json({
    title: share.title,
    expiresAt: new Date(share.expires_ms).toISOString(),
    items,
    nextCursor: (photos?.results.length ?? 0) > limit ? items.at(-1)!.id : null,
  });
}
