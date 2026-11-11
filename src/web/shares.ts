import bcrypt from 'bcryptjs';
import { authenticate, type Identity } from '../poc/auth';
import { body, digest, HttpError } from '../poc/http';
import { media } from '../poc/media';
import { queuePreviews, readPreview, runPreviews } from '../poc/previews';
import { safeArchiveName } from './archive-plan';
import { field, only, pageSize, sameOrigin, uuid } from './common';
import {
  active,
  joined,
  parseSharePassword,
  passwordRequired,
  shareCredentials,
  shareSecret,
  unavailable,
  unlocked,
} from './share-access';

type Share = {
  id: string;
  title: string;
  album_id: string | null;
  asset_ids: string | null;
  created_ms: number;
  expires_ms: number;
  password_required: number;
  allow_download: number;
};

const eligible = "a.media_type='IMAGE' AND a.visibility='timeline' AND a.deleted_at IS NULL";
const sessionValid = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.id=? AND s.user_id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)`;
const columns =
  'id,title,album_id,asset_ids,created_ms,expires_ms,password_hash IS NOT NULL AS password_required,allow_download';
const publicColumns = `s.title,s.expires_ms,s.allow_download,${unlocked} AS authorized`;
const membership = `a.owner_id=s.owner_id AND ${eligible} AND (
  (s.album_id IS NULL AND a.id IN(SELECT value FROM json_each(s.asset_ids))) OR
  (s.album_id IS NOT NULL AND EXISTS(SELECT 1 FROM album_assets l
    WHERE l.album_id=s.album_id AND l.owner_id=s.owner_id AND l.asset_id=a.id)))`;
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
    passwordRequired: !!share.password_required,
    allowDownload: !!share.allow_download,
  };
}

export async function cleanShares(db: D1Database) {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        'DELETE FROM web_shares WHERE id IN(SELECT id FROM web_shares WHERE expires_ms<=? ORDER BY expires_ms LIMIT 200)',
      )
      .bind(now),
    db
      .prepare(
        'DELETE FROM web_share_access WHERE token_hash IN(SELECT token_hash FROM web_share_access WHERE expires_ms<=? ORDER BY expires_ms LIMIT 200)',
      )
      .bind(now),
  ]);
}

function downloadSetting(input: Record<string, unknown>) {
  if ('allowDownload' in input && typeof input.allowDownload !== 'boolean')
    field('allowDownload', '允许下载原件', '请选择开启或关闭');
  return 'allowDownload' in input ? Number(input.allowDownload) : null;
}

async function createShare(request: Request, db: D1Database, identity: Identity) {
  const input = await body(request);
  only(input, ['albumId', 'ids', 'days', 'password', 'allowDownload']);
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

  const allowDownload = downloadSetting(input) ?? 0;
  const passwordHash =
    input.password == null ? null : await bcrypt.hash(parseSharePassword(input.password), 12);
  const token = shareSecret();
  const id = crypto.randomUUID();
  const tokenHash = await digest(token);
  const now = Date.now();
  const expires = now + days * 86400000;
  const insert =
    'INSERT INTO web_shares(id,owner_id,album_id,asset_ids,token_hash,title,created_ms,expires_ms,password_hash,allow_download)';
  const session = [identity.session_id, identity.id, now];
  // Validate the scope and the current session in the same statement as creation.
  const statement = albumId
    ? db
        .prepare(
          `${insert}
      SELECT ?,b.owner_id,b.id,NULL,?,b.name,?,?,?,? FROM albums b
      WHERE b.id=? AND b.owner_id=? AND ${sessionValid} AND EXISTS(
        SELECT 1 FROM album_assets l JOIN assets a ON a.id=l.asset_id AND a.owner_id=l.owner_id
        WHERE l.album_id=b.id AND l.owner_id=b.owner_id AND ${eligible})
      RETURNING ${columns}`,
        )
        .bind(
          id,
          tokenHash,
          now,
          expires,
          passwordHash,
          allowDownload,
          albumId,
          identity.id,
          ...session,
        )
    : db
        .prepare(
          `${insert}
      SELECT ?,?,NULL,?,?,'所选照片',?,?,?,? WHERE ${sessionValid} AND ?=(
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
          passwordHash,
          allowDownload,
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
  if (request.method === 'PATCH') {
    const input = await body(request, false, 2048);
    only(input, ['password', 'allowDownload']);
    const changePassword = 'password' in input;
    const allowDownload = downloadSetting(input);
    if (!changePassword && allowDownload === null)
      field('password/allowDownload', '访问密码、允许下载原件', '请至少修改一项');
    const passwordHash =
      changePassword && input.password !== null
        ? await bcrypt.hash(parseSharePassword(input.password), 12)
        : null;
    const now = Date.now();
    const result = await db
      .prepare(
        `UPDATE web_shares SET password_hash=CASE WHEN ? THEN ? ELSE password_hash END,
        allow_download=COALESCE(?,allow_download)
        WHERE id=? AND owner_id=? AND expires_ms>? AND ${sessionValid} RETURNING ${columns}`,
      )
      .bind(
        Number(changePassword),
        passwordHash,
        allowDownload,
        id,
        identity.id,
        now,
        identity.session_id,
        identity.id,
        now,
      )
      .first<Share>();
    if (result) return Response.json(summary(result));
    await authenticate(request, db);
    throw new HttpError(404, '分享链接：不存在或已失效，请刷新分享列表', 'shareId');
  }
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
  action?: string,
  ctx?: ExecutionContext,
) {
  const { link, guest } = await shareCredentials(request);
  const db = env.IMMICH_CF_DB;
  const query = new URL(request.url).searchParams;
  type Grant = { title: string; expires_ms: number; allow_download: number; authorized: number };
  const grantQuery = (now: number) =>
    db.prepare(`SELECT ${publicColumns} ${joined} WHERE ${active}`).bind(guest, now, link, now);
  function requireGrant(grant?: Grant | null) {
    if (!grant) unavailable();
    if (!grant.authorized) passwordRequired();
    return grant;
  }

  if (id) {
    const assetId = uuid(id);
    const download = action === 'download';
    const param = download ? 'component' : 'size';
    const label = download ? '原件类型' : '预览尺寸';
    const choices = download ? ['photo', 'motion'] : ['thumbnail', 'preview'];
    const variant = query.get(param) ?? choices[0];
    if (Array.from(query.keys()).some((key) => key !== param) || query.getAll(param).length > 1)
      field(param, label, '请移除多余的查询参数');
    if (!choices.includes(variant!))
      field(param, label, download ? '请选择 photo 或 motion' : '请选择 thumbnail 或 preview');
    const motion = variant === 'motion';
    const source = motion ? 'm' : 'a';
    const motionJoin = motion
      ? `JOIN assets m ON m.id=a.live_photo_video_id AND m.owner_id=a.owner_id
         AND m.pair_id=a.pair_id AND m.media_type='VIDEO' AND m.visibility='hidden' AND m.deleted_at IS NULL`
      : '';
    type SharedAsset = {
      owner_id: string;
      object_key: string;
      bytes: number;
      checksum: string;
      r2_sha1_verified: number;
      filename: string;
      mime: string;
    };
    const fields = ['object_key', 'bytes', 'checksum', 'r2_sha1_verified', 'filename', 'mime'];
    async function checkAsset() {
      const now = Date.now();
      const asset = await db
        .prepare(
          `SELECT s.owner_id,${fields.map((name) => source + '.' + name).join(',')}
         ${joined} JOIN assets a ON a.id=? AND ${membership} ${motionJoin}
         WHERE ${active} AND ${unlocked} ${download ? 'AND s.allow_download=1' : ''}`,
        )
        .bind(assetId, link, now, guest, now)
        .first<SharedAsset>();
      if (asset) return asset;
      const grant = requireGrant(await grantQuery(Date.now()).first<Grant>());
      if (download && !grant.allow_download)
        throw new HttpError(403, '此分享未开放原件下载，请联系分享者');
      throw new HttpError(404, '这份照片或动态原件不在分享范围内');
    }
    const asset = await checkAsset();
    let result: Response;
    try {
      if (download) {
        result = await media(
          request,
          env.IMMICH_CF_MEDIA,
          asset.object_key,
          asset.mime,
          asset.bytes,
          asset.checksum,
          !!asset.r2_sha1_verified,
        );
      } else {
        await queuePreviews(env, assetId);
        const preview = runPreviews(env, assetId);
        if (ctx) ctx.waitUntil(preview.catch(() => undefined));
        else await preview;
        result = await readPreview(
          request,
          env,
          assetId,
          asset.owner_id,
          variant === 'preview' ? 2048 : 256,
        );
      }
    } catch (error) {
      await checkAsset();
      if (error instanceof HttpError && error.status === 503)
        throw new HttpError(
          503,
          download ? '原件暂不可下载，请稍后重试' : '照片预览暂不可用，请稍后重试',
        );
      throw error;
    }
    try {
      const current = await checkAsset();
      if (
        download &&
        (current.object_key !== asset.object_key || current.checksum !== asset.checksum)
      )
        throw new HttpError(409, '原件已变化，请重新下载');
    } catch (error) {
      await result.body?.cancel();
      throw error;
    }
    if (download) {
      const name = encodeURIComponent(safeArchiveName(asset.filename)).replaceAll("'", '%27');
      const ext =
        { 'image/png': 'png', 'image/heic': 'heic', 'video/quicktime': 'mov' }[asset.mime] ?? 'jpg';
      result.headers.set(
        'Content-Disposition',
        `attachment; filename="photo.${ext}"; filename*=UTF-8''${name}`,
      );
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
    grantQuery(now),
    db
      .prepare(
        `SELECT a.id,(s.allow_download=1 AND a.live_photo_video_id IS NOT NULL) AS has_motion
         ${joined} JOIN assets a ON ${membership}
         WHERE ${active} AND ${unlocked} AND a.id>? ORDER BY a.id LIMIT ?`,
      )
      .bind(link, now, guest, now, cursor, limit + 1),
  ]);
  const share = requireGrant(grants?.results[0] as Grant | undefined);
  const rows = (photos?.results ?? []).slice(0, limit) as { id: string; has_motion: number }[];
  const items = rows.map(({ id, has_motion }) => (has_motion ? { id, hasMotion: true } : { id }));
  return Response.json({
    title: share.title,
    expiresAt: new Date(share.expires_ms).toISOString(),
    allowDownload: !!share.allow_download,
    items,
    nextCursor: (photos?.results.length ?? 0) > limit ? items.at(-1)!.id : null,
  });
}
