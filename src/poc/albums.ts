import { type Identity, userDto } from './auth';
import { body, digest, HttpError, invalid } from './http';

interface Album {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  thumbnail_asset_id: string | null;
  sort_order: string;
  created_at: string;
  updated_at: string;
  sync_seq: number;
  created_seq: number;
  asset_count: number;
  start_date: string | null;
  end_date: string | null;
}
const uuid = (value: unknown, field: string): string => {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  )
    invalid(field, '请提供有效的 UUID v4');
  return value.toLowerCase();
};
function ids(value: unknown, field: string, optional = false) {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000 || (!optional && value.length === 0))
    invalid(field, optional ? '最多提供 1000 个资产 ID' : '必须提供 1～1000 个资产 ID');
  return [...new Set(value.map((id) => uuid(id, field)))];
}
function text(value: unknown, field: string, max: number, nullable = false) {
  if (nullable && value === null) return '';
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > max)
    invalid(field, `必须为最多 ${max} UTF-8 字节的文本${nullable ? '或 null' : ''}`);
  if (field === 'albumName' && (!value.trim() || /[\x00-\x1f\x7f]/.test(value)))
    invalid(field, '不能为空或包含控制字符，请填写相册名称');
  return field === 'albumName' ? value.trim() : value;
}
const selectAlbum = `SELECT b.*,(SELECT COUNT(*) FROM album_assets l WHERE l.album_id=b.id) asset_count,
 (SELECT MIN(a.file_created_at) FROM album_assets l JOIN assets a ON a.id=l.asset_id WHERE l.album_id=b.id) start_date,
 (SELECT MAX(a.file_created_at) FROM album_assets l JOIN assets a ON a.id=l.asset_id WHERE l.album_id=b.id) end_date FROM albums b`;
export function albumDto(row: Album, identity: Identity) {
  return {
    id: row.id,
    albumName: row.name,
    description: row.description,
    albumThumbnailAssetId: row.thumbnail_asset_id,
    albumUsers: [{ role: 'owner', user: userDto(identity) }],
    assetCount: row.asset_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActivityEnabled: false,
    order: row.sort_order,
    shared: false,
    hasSharedLink: false,
    ...(row.start_date ? { startDate: row.start_date, endDate: row.end_date } : {}),
  };
}
export async function albums(
  request: Request,
  db: D1Database,
  identity: Identity,
  albumId?: string,
  assetsPath = false,
) {
  const id = albumId === undefined ? undefined : uuid(albumId, 'id');
  if (request.method === 'GET') {
    const query = new URL(request.url).searchParams;
    const allowed = id ? ['key', 'slug'] : ['assetId', 'id', 'name', 'isOwned', 'isShared'];
    for (const field of query.keys())
      if (!allowed.includes(field)) invalid(field, '此查询参数尚不支持，请移除此参数');
    if (id && query.size)
      invalid('key/slug', '个人相册不支持共享访问，请移除共享参数并使用本人会话');
    let where = 'b.owner_id=?';
    const values: (string | number)[] = [identity.id];
    for (const key of ['isOwned', 'isShared'])
      if (query.has(key) && !['true', 'false'].includes(query.get(key)!))
        invalid(key, '必须为 true 或 false');
    if (id) {
      where += ' AND b.id=?';
      values.push(id);
    } else if (query.has('assetId')) {
      where += ' AND EXISTS(SELECT 1 FROM album_assets l WHERE l.album_id=b.id AND l.asset_id=?)';
      values.push(uuid(query.get('assetId'), 'assetId'));
    } else {
      if (query.has('id')) {
        where += ' AND b.id=?';
        values.push(uuid(query.get('id'), 'id'));
      }
      if (query.has('name')) {
        where += ' AND b.name=?';
        values.push(text(query.get('name'), 'name', 255));
      }
      if (query.get('isOwned') === 'false' || query.get('isShared') === 'true') where += ' AND 0';
    }
    const rows = await db
      .prepare(`${selectAlbum} WHERE ${where} ORDER BY b.created_at DESC,b.id`)
      .bind(...values)
      .all<Album>();
    if (id && !rows.results[0])
      throw new HttpError(404, 'id：相册不存在或无权访问，请重新同步', 'id');
    return Response.json(
      id
        ? albumDto(rows.results[0]!, identity)
        : rows.results.map((row) => albumDto(row, identity)),
    );
  }
  const create = !id;
  const operation = create
    ? 'create'
    : assetsPath
      ? request.method === 'PUT'
        ? 'add'
        : 'remove'
      : request.method === 'DELETE'
        ? 'delete'
        : 'patch';
  const input = operation === 'delete' ? {} : await body(request);
  const allowed = create
    ? ['albumName', 'description', 'assetIds', 'albumUsers']
    : assetsPath
      ? ['ids']
      : ['albumName', 'description', 'albumThumbnailAssetId', 'isActivityEnabled', 'order'];
  for (const field of Object.keys(input))
    if (!allowed.includes(field)) invalid(field, '当前个人相册不支持此字段，请移除');
  if (
    input.albumUsers !== undefined &&
    (!Array.isArray(input.albumUsers) || input.albumUsers.length)
  )
    invalid('albumUsers', '当前仅支持个人相册，请移除共享用户或填写空数组');
  const name =
    create || input.albumName !== undefined ? text(input.albumName, 'albumName', 255) : null;
  const description =
    input.description !== undefined ? text(input.description, 'description', 8192, true) : null;
  if (input.isActivityEnabled !== undefined && input.isActivityEnabled !== false)
    invalid('isActivityEnabled', '相册活动尚未支持，请设为 false 或省略');
  if (
    input.order !== undefined &&
    (typeof input.order !== 'string' || !['asc', 'desc'].includes(input.order))
  )
    invalid('order', '必须为 asc 或 desc');
  const cover =
    input.albumThumbnailAssetId === undefined
      ? ''
      : uuid(input.albumThumbnailAssetId, 'albumThumbnailAssetId');
  const assetIds = ids(
    create ? input.assetIds : assetsPath ? input.ids : undefined,
    create ? 'assetIds' : 'ids',
    !assetsPath,
  );
  const requestKey = create ? (request.headers.get('Idempotency-Key') ?? '') : '';
  if (requestKey && !/^[a-zA-Z0-9-]{1,128}$/.test(requestKey))
    invalid('Idempotency-Key', '请使用最多 128 字符的字母、数字或连字符');
  const requestHash = create
    ? await digest(
        JSON.stringify({ name, description: description ?? '', ids: [...assetIds].sort() }),
      )
    : '';
  let target = id ?? crypto.randomUUID();
  if (create && requestKey) {
    const hash = await digest(identity.id + ':' + requestKey);
    target = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }
  const guard = crypto.randomUUID(),
    now = new Date().toISOString(),
    encoded = JSON.stringify(assetIds);
  const statements = [
    db
      .prepare(
        `INSERT INTO album_write_guards SELECT ?,?,?,?,?,?,?,?,?,?,NOT EXISTS(SELECT 1 FROM albums WHERE id=?),
    COALESCE((SELECT json_group_array(asset_id) FROM album_assets WHERE album_id=?),'[]')`,
      )
      .bind(
        guard,
        identity.session_id,
        identity.id,
        target,
        operation,
        encoded,
        cover,
        requestKey,
        requestHash,
        Date.now(),
        target,
        target,
      ),
  ];
  if (create) {
    if (requestKey)
      statements.push(
        db
          .prepare(
            'INSERT INTO album_create_requests VALUES(?,?,?,?) ON CONFLICT(owner_id,request_key) DO NOTHING',
          )
          .bind(identity.id, requestKey, requestHash, target),
      );
    statements.push(
      db
        .prepare(
          `INSERT INTO albums(id,owner_id,name,description,created_at,updated_at) SELECT ?,?,?,?,?,? FROM album_write_guards WHERE id=? AND apply=1`,
        )
        .bind(target, identity.id, name, description ?? '', now, now, guard),
    );
  }
  if (create || operation === 'add')
    statements.push(
      db
        .prepare(
          `INSERT INTO album_assets(album_id,asset_id,owner_id)
    SELECT ?,value,? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM album_write_guards WHERE id=? AND (?=0 OR apply=1))
    ON CONFLICT(album_id,asset_id) DO NOTHING`,
        )
        .bind(target, identity.id, encoded, guard, create ? 1 : 0),
    );
  if (operation === 'remove')
    statements.push(
      db
        .prepare(
          'DELETE FROM album_assets WHERE album_id=? AND asset_id IN(SELECT value FROM json_each(?))',
        )
        .bind(target, encoded),
    );
  if (operation === 'patch')
    statements.push(
      db
        .prepare(
          `UPDATE albums SET name=COALESCE(?,name),description=COALESCE(?,description),
    sort_order=COALESCE(?,sort_order),thumbnail_asset_id=CASE WHEN ?='' THEN thumbnail_asset_id ELSE ? END WHERE id=? AND owner_id=?`,
        )
        .bind(name, description, input.order ?? null, cover, cover, target, identity.id),
    );
  if (operation === 'delete')
    statements.push(
      db.prepare('DELETE FROM albums WHERE id=? AND owner_id=?').bind(target, identity.id),
    );
  statements.push(
    db.prepare(`${selectAlbum} WHERE b.id=? AND b.owner_id=?`).bind(target, identity.id),
  );
  statements.push(db.prepare('SELECT existing_ids FROM album_write_guards WHERE id=?').bind(guard));
  statements.push(db.prepare('DELETE FROM album_write_guards WHERE id=?').bind(guard));
  try {
    const result = await db.batch(statements);
    if (operation === 'delete') return new Response(null, { status: 204 });
    if (assetsPath) {
      const existing = new Set(
        JSON.parse(
          (result.at(-2)!.results[0] as { existing_ids: string }).existing_ids,
        ) as string[],
      );
      return Response.json(
        assetIds.map((assetId) => {
          const ok = operation === 'add' ? !existing.has(assetId) : existing.has(assetId);
          return {
            id: assetId,
            success: ok,
            ...(!ok
              ? {
                  error: operation === 'add' ? 'duplicate' : 'not_found',
                  errorMessage:
                    operation === 'add' ? 'ids：照片已在相册中' : 'ids：相册中不存在此照片关系',
                }
              : {}),
          };
        }),
      );
    }
    const row = result.at(-3)!.results[0] as unknown as Album | undefined;
    if (!row) throw new HttpError(409, 'id：相册已删除，请刷新列表，不要重建同一请求', 'id');
    return Response.json(albumDto(row, identity), { status: create ? 201 : 200 });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = String(error);
    if (message.includes('ALBUM_SESSION')) throw new HttpError(401, '会话已失效，请重新登录');
    if (message.includes('ALBUM_REQUEST_CONFLICT'))
      throw new HttpError(
        409,
        'Idempotency-Key：该键已用于不同内容，请使用新键',
        'Idempotency-Key',
      );
    if (message.includes('ALBUM_RETIRED'))
      throw new HttpError(
        409,
        'Idempotency-Key：该请求的相册已删除，请刷新列表；新建请使用新键',
        'Idempotency-Key',
      );
    if (message.includes('ALBUM_NOT_FOUND'))
      throw new HttpError(404, 'id：相册不存在或无权修改，请重新同步', 'id');
    if (message.includes('ALBUM_ASSET_PERMISSION'))
      throw new HttpError(
        404,
        `${create ? 'assetIds' : 'ids'}：照片不存在或无权访问，请先同步本人照片`,
        create ? 'assetIds' : 'ids',
      );
    if (message.includes('ALBUM_COVER'))
      invalid('albumThumbnailAssetId', '封面必须是当前相册中的本人照片，请先添加照片');
    if (message.includes('ALBUM_LIMIT'))
      invalid('albumName', '每个账号最多 100 个个人相册，请先移除不需要的相册');
    throw new HttpError(503, '相册：提交结果暂不可确认，请先刷新列表；有幂等键的新建可用原键重试');
  }
}
