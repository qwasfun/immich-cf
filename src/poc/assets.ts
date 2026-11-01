import { authenticate, type Identity } from './auth';
import { body, HttpError, invalid } from './http';
import { assetQuota, assetLimit } from './quota';
import { imageHeader } from './image-header';
import { media } from './media';
import { guardLivePhoto } from './live-photo';
import { originalMatches } from './integrity';
import { uploadLive } from './live-upload';
import { readPreview, runPreviews } from './previews';

import { MAX_IMAGE, parseUploadForm } from './multipart';

export { MAX_IMAGE } from './multipart';
export interface Asset {
  seq: number;
  sync_seq: number;
  id: string;
  owner_id: string;
  checksum: string;
  object_key: string;
  filename: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  file_created_at: string;
  file_modified_at: string;
  favorite: number;
  metadata: string;
  r2_sha1_verified: number;
  media_type: 'IMAGE' | 'VIDEO';
  visibility: 'timeline' | 'hidden';
  duration: string | null;
  pair_id: string | null;
  live_photo_video_id: string | null;
  logical_key: string;
}
function checksum(value: unknown, field: string) {
  if (typeof value !== 'string') invalid(field, '必须填写 SHA-1 的十六进制或 Base64 字符串');
  if (/^[a-f0-9]{40}$/i.test(value))
    return btoa(String.fromCharCode(...value.match(/../g)!.map((x) => parseInt(x, 16))));
  if (!/^[A-Za-z0-9+/]{27}=$/.test(value)) invalid(field, '必须填写有效的 SHA-1 校验和');
  return value;
}
export async function upload(request: Request, env: Env, identity: Identity) {
  if (String(env.ENABLE_LIVE_PHOTO) === 'true') return uploadLive(request, env, identity);
  const form = await parseUploadForm(request);
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  for (const key of form.keys()) {
    if (!key || encoder.encode(key).byteLength > 128 || /[\x00-\x1f\x7f]/.test(key))
      invalid('上传字段名', '请使用不含控制字符且最多 128 UTF-8 字节的非空名称');
    if (seen.has(key)) invalid(key, '只能提交一次');
    seen.add(key);
  }
  await guardLivePhoto(form, env.IMMICH_CF_DB, identity.id);
  // Bound parsed fields too, including ignored forward-compatible text fields.
  // Keep the Live Photo guard first so malformed follow-up fields cannot erase a block.
  let fields = 0,
    textBytes = 0;
  for (const [key, value] of form) {
    if (++fields > 32) invalid('上传表单', '最多提交 32 个字段，请减少附加字段');
    if (value instanceof File) {
      if (key !== 'assetData') invalid(key, '当前仅 assetData 支持文件，请移除附加文件');
    } else {
      const length = encoder.encode(value).byteLength;
      if (length > 8192) invalid(key, '最多 8 KiB UTF-8 文本，请缩短此字段');
      textBytes += length;
      if (textBytes > 16384)
        invalid('上传文本字段', '合计最多 16 KiB UTF-8 文本，请减少附加字段内容');
    }
  }
  const file = form.get('assetData');
  if (!(file instanceof File) || file.size === 0) invalid('assetData', '请选择非空图片文件');
  if (file.size > MAX_IMAGE)
    throw new HttpError(413, 'assetData：图片最多 4 MiB，请压缩后上传', 'assetData');
  for (const field of ['sidecarData', 'livePhotoVideoId'])
    if (form.has(field)) invalid(field, '当前只支持独立静态图片，请移除此字段');
  if (form.has('duration') && form.get('duration') !== '0')
    invalid('duration', '静态图片时长必须为 0');
  if (form.has('visibility') && form.get('visibility') !== 'timeline')
    invalid('visibility', '当前只支持 timeline，请勿上传隐藏或锁定图片');
  const favorite = form.get('isFavorite') ?? 'false';
  if (!['true', 'false'].includes(String(favorite)))
    invalid('isFavorite', '必须填写 true 或 false');
  const date = (field: string) => {
    const value = form.get(field);
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      invalid(field, '请填写带时区的有效 ISO 日期时间');
    const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [
      number,
      number,
      number,
    ];
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
      invalid(field, '日期不存在，请检查年月日');
    return new Date(value).toISOString();
  };
  const created = date('fileCreatedAt'),
    modified = date('fileModifiedAt');
  const name = form.get('filename') ?? file.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f\\/]/.test(name))
    invalid('filename', '请使用不含路径和控制字符的文件名，最多 255 字符');
  let metadata: { key: string; value: Record<string, unknown> }[] = [];
  if (form.has('metadata')) {
    const raw = form.get('metadata');
    if (typeof raw !== 'string') invalid('metadata', '请提供最多 8 KiB 的 JSON 数组');
    try {
      metadata = JSON.parse(raw);
    } catch {
      invalid('metadata', '请提供有效 JSON 数组');
    }
    if (
      !Array.isArray(metadata) ||
      metadata.length > 1 ||
      metadata.some(
        (x) =>
          !x ||
          x.key !== 'mobile-app' ||
          !x.value ||
          typeof x.value !== 'object' ||
          Array.isArray(x.value),
      )
    )
      invalid('metadata', '当前只支持一项 mobile-app 对象');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = imageHeader(bytes);
  const sha1 = await crypto.subtle.digest('SHA-1', bytes);
  const hash = btoa(String.fromCharCode(...new Uint8Array(sha1)));
  const expected = request.headers.get('x-immich-checksum');
  if (expected && checksum(expected, 'x-immich-checksum') !== hash)
    invalid('x-immich-checksum', '与文件内容不符，请重新计算后上传');
  const db = env.IMMICH_CF_DB;
  const find = () =>
    db
      .prepare(
        'SELECT id,object_key,mime,bytes,r2_sha1_verified FROM assets WHERE owner_id = ? AND checksum = ?',
      )
      .bind(identity.id, hash)
      .first<{
        id: string;
        object_key: string;
        mime: string;
        bytes: number;
        r2_sha1_verified: number;
      }>();
  const duplicate = async (existing: {
    id: string;
    object_key: string;
    mime: string;
    bytes: number;
    r2_sha1_verified: number;
  }) => {
    // A retry also repairs a missing object, without changing the published asset or cursor.
    const object = await env.IMMICH_CF_MEDIA.head(existing.object_key);
    if (!originalMatches(object, existing.bytes, hash, true)) {
      const repaired = await env.IMMICH_CF_MEDIA.put(existing.object_key, bytes, {
        httpMetadata: { contentType: existing.mime },
        sha1,
      });
      if (!originalMatches(repaired, existing.bytes, hash, true))
        throw new HttpError(503, 'assetData：原图校验暂未确认，请重试同一图片', 'assetData');
    }
    if (!existing.r2_sha1_verified)
      await db
        .prepare(
          'UPDATE assets SET r2_sha1_verified=1 WHERE id=? AND owner_id=? AND r2_sha1_verified=0',
        )
        .bind(existing.id, identity.id)
        .run();
    const current = await db
      .prepare(
        `SELECT a.id FROM assets a WHERE a.id=? AND a.owner_id=? AND a.object_key=?
      AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=a.owner_id AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)`,
      )
      .bind(existing.id, identity.id, existing.object_key, identity.session_id, Date.now())
      .first();
    if (!current)
      throw new HttpError(409, 'assetData：资产已删除或会话已改变，请刷新后重新备份', 'assetData');
    return Response.json({ id: existing.id, status: 'duplicate' });
  };
  try {
    const existing = await find();
    if (existing) return await duplicate(existing);
    const candidate = crypto.randomUUID();
    // Reserve before R2, so every retry/concurrent request reuses the same private key.
    // The SELECT also handles an upload that committed since the initial lookup.
    await db
      .prepare(
        `INSERT INTO upload_intents (owner_id,checksum,id,object_key,created_at)
        SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM assets WHERE owner_id=? AND checksum=?)
        ON CONFLICT(owner_id,checksum) DO NOTHING`,
      )
      .bind(
        identity.id,
        hash,
        candidate,
        `${identity.id}/${candidate}/original`,
        new Date().toISOString(),
        identity.id,
        hash,
      )
      .run();
    const intent = await db
      .prepare(
        'SELECT id,object_key,created_at FROM upload_intents WHERE owner_id=? AND checksum=?',
      )
      .bind(identity.id, hash)
      .first<{ id: string; object_key: string; created_at: string }>();
    if (!intent) {
      const committed = await find();
      if (committed) return await duplicate(committed);
      throw new HttpError(503, 'assetData：上传状态暂不可确认，请重试同一图片', 'assetData');
    }
    if (await db.prepare('SELECT id FROM retired_assets WHERE id=?').bind(intent.id).first())
      throw new HttpError(
        409,
        'assetData：保留预约对应已删除资产，请先核对预约后重试，避免重新发布旧资产',
        'assetData',
      );
    const stored = await env.IMMICH_CF_MEDIA.put(intent.object_key, bytes, {
      httpMetadata: { contentType: info.mime },
      sha1,
    });
    if (!originalMatches(stored, file.size, hash, true))
      throw new HttpError(503, 'assetData：原图校验暂未确认，请重试同一图片', 'assetData');
    // D1 batch is transactional: publishing and removing the intent succeed together.
    // Never delete this shared R2 key on an ambiguous failure or a competing retry.
    const result = await db.batch([
      db
        .prepare(
          `INSERT INTO assets
        (id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite,metadata,r2_sha1_verified)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(owner_id,checksum) DO NOTHING`,
        )
        .bind(
          intent.id,
          identity.id,
          hash,
          intent.object_key,
          name,
          info.mime,
          file.size,
          info.width,
          info.height,
          intent.created_at,
          created,
          modified,
          favorite === 'true' ? 1 : 0,
          JSON.stringify(metadata),
        ),
      db
        .prepare(
          `DELETE FROM upload_intents WHERE owner_id=? AND checksum=?
          AND EXISTS (SELECT 1 FROM assets WHERE id=?)`,
        )
        .bind(identity.id, hash, intent.id),
    ]);
    const saved = await find();
    if (!saved)
      throw new HttpError(503, 'assetData：保存结果暂不可确认，请重试同一图片', 'assetData');
    // An older in-flight Worker may have published a different ID during rollout.
    // Return the actual row and retain the unused intent for later reconciliation.
    // Quota counts this owner/checksum once even while the redundant intent remains.
    if (saved.id !== intent.id) return await duplicate(saved);
    return Response.json(
      { id: intent.id, status: result[0]!.meta.changes ? 'created' : 'duplicate' },
      { status: result[0]!.meta.changes ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.message.includes('ASSET_LIMIT'))
      assetLimit((await assetQuota(db, identity.id)).limitValue);
    throw new HttpError(503, 'assetData：图片暂未确认保存，请稍后重试同一图片', 'assetData');
  }
}
export async function bulkCheck(request: Request, env: Env, identity: Identity) {
  const input = await body(request);
  if (!Array.isArray(input.assets) || input.assets.length > 1000)
    invalid('assets', '必须为数组且最多 1000 项');
  const entries = input.assets.map((item, i) => {
    if (!item || typeof item.id !== 'string' || item.id.length > 255)
      invalid(`assets.${i}.id`, '必须为最多 255 字符的字符串');
    return { id: item.id as string, checksum: checksum(item.checksum, `assets.${i}.checksum`) };
  });
  const rows = await env.IMMICH_CF_DB.prepare(
    `SELECT a.id,a.owner_id,a.checksum,a.object_key,a.bytes,a.r2_sha1_verified,a.deleted_at,a.live_photo_video_id,
    v.id video_id,v.object_key video_key,v.bytes video_bytes,v.checksum video_checksum,v.r2_sha1_verified video_verified
    FROM assets a LEFT JOIN assets v ON v.id=a.live_photo_video_id AND v.owner_id=a.owner_id AND v.media_type='VIDEO' AND v.visibility='hidden' AND v.pair_id=a.pair_id AND v.deleted_at IS a.deleted_at
    WHERE a.owner_id=? AND a.visibility='timeline' AND a.checksum IN(SELECT value FROM json_each(?))`,
  )
    .bind(identity.id, JSON.stringify([...new Set(entries.map((entry) => entry.checksum))]))
    .all<{
      id: string;
      checksum: string;
      object_key: string;
      bytes: number;
      r2_sha1_verified: number;
      deleted_at: string | null;
      live_photo_video_id: string | null;
      video_id: string | null;
      video_key: string;
      video_bytes: number;
      video_checksum: string;
      video_verified: number;
    }>();
  // Inspect only the requested owner/checksum matches, never the full library.
  // An unavailable store is not evidence of either a duplicate or a missing original.
  const requested = new Set(entries.map((entry) => entry.checksum));
  const available = new Map<string, { id: string; isTrashed: boolean }>();
  try {
    for (const row of rows.results) {
      if (!requested.has(row.checksum)) continue;
      const object = await env.IMMICH_CF_MEDIA.head(row.object_key);
      if (
        originalMatches(object, row.bytes, row.checksum, !!row.r2_sha1_verified) &&
        (!row.live_photo_video_id ||
          (row.video_id &&
            originalMatches(
              await env.IMMICH_CF_MEDIA.head(row.video_key),
              row.video_bytes,
              row.video_checksum,
              !!row.video_verified,
            )))
      )
        available.set(row.checksum, { id: row.id, isTrashed: row.deleted_at !== null });
    }
  } catch {
    throw new HttpError(503, 'assets：暂时无法确认原图是否已保存，请稍后重试备份预检查', 'assets');
  }
  return Response.json({
    results: entries.map((item) => {
      const existing = available.get(item.checksum);
      return existing
        ? {
            id: item.id,
            action: 'reject',
            reason: 'duplicate',
            assetId: existing.id,
            isTrashed: existing.isTrashed,
          }
        : { id: item.id, action: 'accept' };
    }),
  });
}
export function assetDto(row: Asset) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    checksum: row.checksum,
    type: row.media_type ?? 'IMAGE',
    createdAt: row.created_at,
    fileCreatedAt: row.file_created_at,
    fileModifiedAt: row.file_modified_at,
    localDateTime: row.file_created_at,
    originalFileName: row.filename,
    width: row.width,
    height: row.height,
    isFavorite: !!row.favorite,
    isEdited: false,
    visibility: row.visibility ?? 'timeline',
    duration: row.duration ?? null,
    deletedAt: row.deleted_at ?? null,
    libraryId: null,
    livePhotoVideoId: row.live_photo_video_id ?? null,
    stackId: null,
    thumbhash: null,
  };
}
export function assetDetailDto(row: Asset) {
  return {
    ...assetDto(row),
    originalPath: '',
    originalMimeType: row.mime,
    updatedAt: row.updated_at || row.created_at,
    hasMetadata: false,
    isArchived: false,
    isOffline: false,
    isTrashed: !!row.deleted_at,
  };
}

export async function readAsset(
  request: Request,
  env: Env,
  identity: Identity,
  id: string,
  kind?: string,
) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) invalid('id', '请提供有效资产 ID');
  const row = await env.IMMICH_CF_DB.prepare('SELECT * FROM assets WHERE id = ? AND owner_id = ?')
    .bind(id, identity.id)
    .first<Asset>();
  if (!row) throw new HttpError(404, '图片不存在或无权访问');
  if (!kind) return Response.json(assetDetailDto(row));
  if (kind === 'thumbnail' && row.media_type === 'VIDEO') {
    const still = await env.IMMICH_CF_DB.prepare(
      'SELECT id FROM assets WHERE live_photo_video_id=? AND owner_id=?',
    )
      .bind(row.id, identity.id)
      .first<{ id: string }>();
    if (!still)
      throw new HttpError(503, 'preview：动态原件已保存，请先完成配套照片上传', 'preview');
    return readAsset(request, env, identity, still.id, kind);
  }
  if (kind === 'video/playback' && row.media_type !== 'VIDEO')
    throw new HttpError(404, '视频不存在或无权访问');
  const size = new URL(request.url).searchParams.get('size');
  if (size && !['thumbnail', 'preview', 'fullsize', 'original'].includes(size))
    invalid('size', '必须为 thumbnail、preview、fullsize 或 original');
  if (kind === 'thumbnail' && row.mime === 'image/heic' && size !== 'original') {
    await runPreviews(env, row.id);
    await authenticate(request, env.IMMICH_CF_DB);
    return readPreview(
      request,
      env,
      row.id,
      identity.id,
      size === 'thumbnail' || !size ? 256 : 2048,
    );
  }
  return media(
    request,
    env.IMMICH_CF_MEDIA,
    row.object_key,
    row.mime,
    row.bytes,
    row.checksum,
    !!row.r2_sha1_verified,
  );
}
