import type { Identity } from './auth';
import { body, HttpError, invalid } from './http';

interface MetadataEntry {
  key: string;
  value: Record<string, unknown>;
  updatedAt?: string;
}
interface MetadataRow {
  id: string;
  metadata: string;
  updated_at: string;
}
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const live = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)`;

// iOS syncCloudIds uses these routes, independently of PUT /assets favorite edits.
// Keep the mobile-app object opaque: its iCloudId and location values are private.
export async function assetMetadata(
  request: Request,
  db: D1Database,
  identity: Identity,
  id?: string,
  key?: string,
) {
  if (id !== undefined && !validId(id)) invalid('id', '请提供有效照片资产 ID');
  id = id?.toLowerCase();
  for (const field of new URL(request.url).searchParams.keys())
    invalid(field, '此元数据接口不接受查询字段，请移除');
  if (key !== undefined && key !== 'mobile-app')
    invalid('key', '当前仅支持 mobile-app 元数据，请核对元数据键');
  const session = [identity.session_id, identity.id, Date.now()];
  const responseItems = (row: MetadataRow) =>
    (JSON.parse(row.metadata) as MetadataEntry[]).map((entry) => ({
      key: entry.key,
      value: entry.value,
      updatedAt: entry.updatedAt ?? row.updated_at,
    }));
  if (request.method === 'GET') {
    const row = await db
      .prepare(`SELECT id,metadata,updated_at FROM assets WHERE id=? AND owner_id=? AND ${live}`)
      .bind(id, identity.id, ...session)
      .first<MetadataRow>();
    if (!row) throw new HttpError(404, 'id：照片不存在或无权读取，请重新同步后重试', 'id');
    const items = responseItems(row);
    if (key === undefined) return Response.json(items);
    const item = items.find((entry) => entry.key === key);
    if (!item) throw new HttpError(404, 'key：尚未保存此元数据，请先完成照片标识同步', 'key');
    return Response.json(item);
  }
  const input = await body(request);
  for (const field of Object.keys(input))
    if (field !== 'items') invalid(field, '此接口仅接受 items 元数据数组，请移除此字段');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 1000)
    invalid('items', '请提供 1～1000 项元数据；请求体合计最多 64 KiB');
  const seen = new Set<string>();
  const items = input.items.map((raw: unknown, index: number) => {
    const field = `items[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      invalid(field, '必须为包含 key 和 value 的对象');
    const item = raw as Record<string, unknown>;
    for (const name of Object.keys(item))
      if (!['key', 'value', ...(id === undefined ? ['assetId'] : [])].includes(name))
        invalid(field, '只能包含 key、value；批量请求还须包含 assetId');
    const assetId = id ?? item.assetId;
    if (!validId(assetId)) invalid(`${field}.assetId`, '请提供有效照片资产 ID');
    if (item.key !== 'mobile-app')
      invalid(`${field}.key`, '当前仅支持 mobile-app 元数据，请核对元数据键');
    if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value))
      invalid(`${field}.value`, '必须为 JSON 对象，请保留 App 生成的照片标识元数据');
    let encoded: string;
    try {
      encoded = JSON.stringify(item.value);
    } catch {
      invalid(`${field}.value`, 'JSON 对象层级过深，请减少嵌套');
    }
    if (new TextEncoder().encode(encoded).length > 8192)
      invalid(`${field}.value`, '最多 8 KiB UTF-8 JSON，请减少元数据内容');
    const normalized = assetId.toLowerCase();
    if (seen.has(normalized))
      invalid(`${field}.assetId`, '同一照片的 mobile-app 元数据只能提交一次，请合并重复项');
    seen.add(normalized);
    return { assetId: normalized, key: 'mobile-app', value: item.value };
  });
  const ids = JSON.stringify(items.map((item) => item.assetId));
  const selected = `owner_id=? AND media_type='IMAGE' AND id IN(SELECT value FROM json_each(?))`;
  const authorized = `(SELECT COUNT(*) FROM assets WHERE ${selected})=? AND ${live}`;
  // One transaction and an all-items permission predicate prevent partial writes,
  // including when a session is revoked while the request body is arriving.
  const result = await db.batch<MetadataRow>([
    db
      .prepare(
        `SELECT id,metadata,updated_at FROM assets WHERE ${selected} AND ${live} ORDER BY id`,
      )
      .bind(identity.id, ids, ...session),
    db
      .prepare(
        `WITH submitted AS (SELECT json_extract(value,'$.assetId') asset_id,json_extract(value,'$.value') data FROM json_each(?))
        UPDATE assets AS a SET metadata=(SELECT json_group_array(json(value)) FROM (
          SELECT value FROM json_each(a.metadata) WHERE json_extract(value,'$.key')<>'mobile-app'
          UNION ALL SELECT json_object('key','mobile-app','value',json((SELECT data FROM submitted WHERE asset_id=a.id)),'updatedAt',?)
        )) WHERE ${selected} AND ${authorized} AND NOT EXISTS(
          SELECT 1 FROM json_each(a.metadata) e JOIN submitted i ON i.asset_id=a.id
          WHERE json_extract(e.value,'$.key')='mobile-app' AND json_extract(e.value,'$.value')=i.data
        )`,
      )
      .bind(
        JSON.stringify(items),
        new Date().toISOString(),
        identity.id,
        ids,
        identity.id,
        ids,
        items.length,
        ...session,
      ),
    db
      .prepare(
        `SELECT id,metadata,updated_at FROM assets WHERE ${selected} AND ${authorized} ORDER BY id`,
      )
      .bind(identity.id, ids, identity.id, ids, items.length, ...session),
  ]);
  if (result[0]!.results.length !== items.length || result[2]!.results.length !== items.length) {
    const available = new Set(result[0]!.results.map((row) => row.id));
    const index = Math.max(
      0,
      items.findIndex((item) => !available.has(item.assetId)),
    );
    throw new HttpError(
      404,
      `items[${index}].assetId：照片不存在、无权修改或不是照片资产，请重新同步并核对资产 ID`,
      `items[${index}].assetId`,
    );
  }
  return Response.json(
    items.map((item) => {
      const row = result[2]!.results.find((row) => row.id === item.assetId)!;
      const entry = responseItems(row).find((entry) => entry.key === item.key)!;
      return id === undefined ? { assetId: row.id, ...entry } : entry;
    }),
  );
}
