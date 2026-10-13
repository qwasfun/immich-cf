import type { Identity } from './auth';
import { body, HttpError, invalid } from './http';
import { imageHeader } from './image-header';

export const MAX_IMAGE = 2 * 1024 * 1024;
interface Asset {
  seq: number;
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
  file_created_at: string;
  file_modified_at: string;
  favorite: number;
  metadata: string;
}
function checksum(value: unknown, field: string) {
  if (typeof value !== 'string') invalid(field, '必须填写 SHA-1 的十六进制或 Base64 字符串');
  if (/^[a-f0-9]{40}$/i.test(value))
    return btoa(String.fromCharCode(...value.match(/../g)!.map((x) => parseInt(x, 16))));
  if (!/^[A-Za-z0-9+/]{27}=$/.test(value)) invalid(field, '必须填写有效的 SHA-1 校验和');
  return value;
}
async function boundedForm(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data;'))
    throw new HttpError(415, 'Content-Type：请使用 multipart/form-data 上传图片');
  const max = MAX_IMAGE + 64 * 1024;
  if (Number(request.headers.get('content-length')) > max)
    throw new HttpError(413, 'assetData：图片最多 2 MiB，请压缩后上传', 'assetData');
  const reader = request.body?.getReader();
  if (!reader) invalid('assetData', '请选择图片文件');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, 'assetData：图片最多 2 MiB，请压缩后上传', 'assetData');
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return await new Response(data, {
      headers: { 'Content-Type': request.headers.get('content-type')! },
    }).formData();
  } catch {
    return invalid('assetData', '上传表单无效，请重新选择图片上传');
  }
}
export async function upload(request: Request, env: Env, identity: Identity) {
  const form = await boundedForm(request);
  for (const key of new Set(form.keys()))
    if (form.getAll(key).length !== 1) invalid(key, '只能提交一次');
  const file = form.get('assetData');
  if (!(file instanceof File) || file.size === 0) invalid('assetData', '请选择非空图片文件');
  if (file.size > MAX_IMAGE)
    throw new HttpError(413, 'assetData：图片最多 2 MiB，请压缩后上传', 'assetData');
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
    if (typeof raw !== 'string' || raw.length > 8192)
      invalid('metadata', '请提供最多 8 KiB 的 JSON 数组');
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
  const hash = btoa(
    String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))),
  );
  const expected = request.headers.get('x-immich-checksum');
  if (expected && checksum(expected, 'x-immich-checksum') !== hash)
    invalid('x-immich-checksum', '与文件内容不符，请重新计算后上传');
  const db = env.IMMICH_CF_DB;
  const find = () =>
    db
      .prepare('SELECT id,object_key,mime FROM assets WHERE owner_id = ? AND checksum = ?')
      .bind(identity.id, hash)
      .first<{ id: string; object_key: string; mime: string }>();
  const duplicate = async (existing: { id: string; object_key: string; mime: string }) => {
    // A retry also repairs a missing object, without changing the published asset or cursor.
    if (!(await env.IMMICH_CF_MEDIA.head(existing.object_key)))
      await env.IMMICH_CF_MEDIA.put(existing.object_key, bytes, {
        httpMetadata: { contentType: existing.mime },
      });
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
    await env.IMMICH_CF_MEDIA.put(intent.object_key, bytes, {
      httpMetadata: { contentType: info.mime },
    });
    // D1 batch is transactional: publishing and removing the intent succeed together.
    // Never delete this shared R2 key on an ambiguous failure or a competing retry.
    const result = await db.batch([
      db
        .prepare(
          `INSERT INTO assets
        (id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite,metadata)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,checksum) DO NOTHING`,
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
    if (saved.id !== intent.id) return await duplicate(saved);
    return Response.json(
      { id: intent.id, status: result[0]!.meta.changes ? 'created' : 'duplicate' },
      { status: result[0]!.meta.changes ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.message.includes('ASSET_LIMIT'))
      throw new HttpError(
        409,
        'assetData：当前实验账户最多 20 张（含待恢复上传），请重试未完成图片或停止批量备份',
        'assetData',
      );
    throw new HttpError(503, 'assetData：图片暂未确认保存，请稍后重试同一图片', 'assetData');
  }
}
export async function bulkCheck(request: Request, db: D1Database, identity: Identity) {
  const input = await body(request);
  if (!Array.isArray(input.assets) || input.assets.length > 1000)
    invalid('assets', '必须为数组且最多 1000 项');
  const entries = input.assets.map((item, i) => {
    if (!item || typeof item.id !== 'string' || item.id.length > 255)
      invalid(`assets.${i}.id`, '必须为最多 255 字符的字符串');
    return { id: item.id as string, checksum: checksum(item.checksum, `assets.${i}.checksum`) };
  });
  const rows = await db
    .prepare('SELECT id,checksum FROM assets WHERE owner_id = ?')
    .bind(identity.id)
    .all<{ id: string; checksum: string }>();
  return Response.json({
    results: entries.map((item) => {
      const existing = rows.results.find((row) => row.checksum === item.checksum);
      return existing
        ? {
            id: item.id,
            action: 'reject',
            reason: 'duplicate',
            assetId: existing.id,
            isTrashed: false,
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
    type: 'IMAGE',
    createdAt: row.created_at,
    fileCreatedAt: row.file_created_at,
    fileModifiedAt: row.file_modified_at,
    localDateTime: row.file_created_at,
    originalFileName: row.filename,
    width: row.width,
    height: row.height,
    isFavorite: !!row.favorite,
    isEdited: false,
    visibility: 'timeline',
    duration: null,
    deletedAt: null,
    libraryId: null,
    livePhotoVideoId: null,
    stackId: null,
    thumbhash: null,
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
  if (!kind)
    return Response.json({
      ...assetDto(row),
      originalPath: '',
      originalMimeType: row.mime,
      updatedAt: row.created_at,
      hasMetadata: false,
      isArchived: false,
      isOffline: false,
      isTrashed: false,
    });
  const size = new URL(request.url).searchParams.get('size');
  if (size && !['thumbnail', 'preview', 'fullsize', 'original'].includes(size))
    invalid('size', '必须为 thumbnail、preview、fullsize 或 original');
  const object = await env.IMMICH_CF_MEDIA.get(row.object_key);
  if (!object) throw new HttpError(503, '图片暂不可读取，请稍后重试');
  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(object.size),
      ETag: object.httpEtag,
    },
  });
}
export async function assetEvents(db: D1Database, identity: Identity, types: string[]) {
  if (!types.includes('AssetsV2') && !types.includes('AssetMetadataV1')) return [];
  const rows = await db
    .prepare('SELECT * FROM assets WHERE owner_id = ? ORDER BY seq')
    .bind(identity.id)
    .all<Asset>();
  const checkpoints = await db
    .prepare('SELECT type,ack FROM sync_checkpoints WHERE session_id = ?')
    .bind(identity.session_id)
    .all<{ type: string; ack: string }>();
  const events: { type: string; ack: string; data: unknown }[] = [];
  for (const row of rows.results) {
    const cursor = String(row.seq).padStart(20, '0');
    const add = (type: string, data: unknown) => {
      const ack = `${type}|${cursor}`;
      if (!checkpoints.results.some((p) => p.type === type && p.ack >= ack))
        events.push({ type, ack, data });
    };
    if (types.includes('AssetsV2')) add('AssetV2', assetDto(row));
    if (types.includes('AssetMetadataV1'))
      for (const entry of JSON.parse(row.metadata))
        add('AssetMetadataV1', { assetId: row.id, ...entry });
  }
  return events;
}
