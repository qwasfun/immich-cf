import type { Identity } from './auth';
import { type Asset, assetDetailDto } from './assets';
import { body, HttpError, invalid } from './http';

// Frozen v3.3.1 UpdateAssetDto / AssetBulkUpdateDto subset. Unsupported edits fail
// before any write; favorite does not change capture dates or touch R2 bytes.
export async function updateFavorite(
  request: Request,
  db: D1Database,
  identity: Identity,
  id?: string,
) {
  const input = await body(request);
  const bulk = id === undefined;
  for (const field of Object.keys(input))
    if (field !== 'isFavorite' && !(bulk && field === 'ids'))
      invalid(field, '当前仅支持收藏修改，请移除此字段；其他资产编辑尚未实现');
  if (typeof input.isFavorite !== 'boolean') invalid('isFavorite', '必须填写 true 或 false');
  const raw = bulk ? input.ids : [id];
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 1000 ||
    raw.some((value) => typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value))
  )
    invalid(bulk ? 'ids' : 'id', bulk ? '必须提供 1～1000 个有效资产 ID' : '请提供有效资产 ID');
  const ids = [...new Set(raw as string[])];
  const encoded = JSON.stringify(ids);
  const live = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)`;
  const args = [identity.session_id, identity.id, Date.now()];
  const result = await db.batch<Asset>([
    db
      .prepare(
        `UPDATE assets SET favorite=? WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))
      AND (SELECT COUNT(*) FROM assets WHERE owner_id=? AND id IN(SELECT value FROM json_each(?)))=? AND ${live} RETURNING *`,
      )
      .bind(
        input.isFavorite ? 1 : 0,
        identity.id,
        encoded,
        identity.id,
        encoded,
        ids.length,
        ...args,
      ),
    // Read after AFTER triggers so the response contains the committed timestamp.
    db
      .prepare(
        `SELECT * FROM assets WHERE owner_id=? AND id IN(SELECT value FROM json_each(?)) AND ${live} ORDER BY id`,
      )
      .bind(identity.id, encoded, ...args),
  ]);
  if (result[0]!.results.length !== ids.length || result[1]!.results.length !== ids.length)
    throw new HttpError(
      404,
      bulk
        ? 'ids：存在不存在或无权修改的资产，请重新同步后重试'
        : 'id：图片不存在或无权修改，请重新同步后重试',
      bulk ? 'ids' : 'id',
    );
  return bulk
    ? new Response(null, { status: 204 })
    : Response.json(assetDetailDto(result[1]!.results[0]!));
}
