import type { Identity } from './auth';
import { body, HttpError, invalid } from './http';
import { runPurgeJobs } from './purge';

function ids(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000)
    invalid('ids', '必须为最多1000个有效资产ID的数组');
  return [
    ...new Set(
      value.map((value) => {
        if (
          typeof value !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
        )
          invalid('ids', '请提供有效UUID v4资产ID');
        return value.toLowerCase();
      }),
    ),
  ];
}
export async function trash(
  request: Request,
  env: Env,
  identity: Identity,
  ctx?: ExecutionContext,
) {
  const db = env.IMMICH_CF_DB,
    path = new URL(request.url).pathname;
  const deletion = path === '/api/assets',
    all = path === '/api/trash/empty' || path === '/api/trash/restore';
  const input = await body(request, all);
  for (const field of Object.keys(input))
    if (!(!all && field === 'ids') && !(deletion && field === 'force'))
      invalid(field, '此操作不接受该字段，请移除');
  if (input.force !== undefined && typeof input.force !== 'boolean')
    invalid('force', '必须为 true 或 false');
  const operation = deletion
    ? input.force === true
      ? 'purge'
      : 'trash'
    : path === '/api/trash/empty'
      ? 'purge'
      : 'restore';
  const selected = all ? null : ids(input.ids),
    guard = crypto.randomUUID();
  const statement =
    selected === null
      ? db
          .prepare(
            `INSERT INTO trash_write_guards SELECT ?,?,?,?,COALESCE((SELECT json_group_array(id) FROM assets WHERE owner_id=? AND deleted_at IS NOT NULL),'[]'),?`,
          )
          .bind(guard, identity.session_id, identity.id, operation, identity.id, Date.now())
      : db
          .prepare('INSERT INTO trash_write_guards VALUES(?,?,?,?,?,?)')
          .bind(
            guard,
            identity.session_id,
            identity.id,
            operation,
            JSON.stringify(selected),
            Date.now(),
          );
  const scope =
    'id IN(SELECT value FROM json_each((SELECT ids FROM trash_write_guards WHERE id=?))) AND owner_id=?';
  const statements = [
    statement,
    db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(logical_key,''),'sha1:'||checksum)) n FROM assets WHERE ${scope}`,
      )
      .bind(guard, identity.id),
  ];
  if (operation === 'trash')
    statements.push(
      db
        .prepare(`UPDATE assets SET deleted_at=? WHERE ${scope} AND deleted_at IS NULL`)
        .bind(new Date().toISOString(), guard, identity.id),
    );
  if (operation === 'restore')
    statements.push(
      db
        .prepare(`UPDATE assets SET deleted_at=NULL WHERE ${scope} AND deleted_at IS NOT NULL`)
        .bind(guard, identity.id),
    );
  if (operation === 'purge') {
    statements.push(
      db
        .prepare(
          `INSERT INTO asset_purge_jobs(asset_id,owner_id,created_at) SELECT id,owner_id,? FROM assets WHERE ${scope} ON CONFLICT(asset_id) DO NOTHING`,
        )
        .bind(new Date().toISOString(), guard, identity.id),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO asset_purge_objects(asset_id,owner_id,object_key,kind)
    SELECT p.asset_id,p.owner_id,p.object_key,'preview' FROM media_previews p JOIN assets a ON a.id=p.asset_id
    WHERE a.${scope.replace(' AND owner_id', ' AND a.owner_id')} ON CONFLICT(asset_id,object_key) DO NOTHING`,
        )
        .bind(guard, identity.id),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO asset_purge_objects(asset_id,owner_id,object_key,kind) SELECT id,owner_id,object_key,'original' FROM assets WHERE ${scope} ON CONFLICT(asset_id,object_key) DO NOTHING`,
        )
        .bind(guard, identity.id),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO asset_purge_objects(asset_id,owner_id,object_key,kind) SELECT id,owner_id,integrity_source_key,'source' FROM assets WHERE ${scope} AND integrity_source_key IS NOT NULL ON CONFLICT(asset_id,object_key) DO NOTHING`,
        )
        .bind(guard, identity.id),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO asset_purge_objects(asset_id,owner_id,object_key,kind) SELECT i.asset_id,i.owner_id,i.object_key,'copy' FROM integrity_copy_intents i JOIN assets a ON a.id=i.asset_id WHERE a.${scope.replace(' AND owner_id', ' AND a.owner_id')} AND i.owner_id=a.owner_id ON CONFLICT(asset_id,object_key) DO NOTHING`,
        )
        .bind(guard, identity.id),
    );
    statements.push(db.prepare(`DELETE FROM assets WHERE ${scope}`).bind(guard, identity.id));
  }
  statements.push(db.prepare('SELECT ids FROM trash_write_guards WHERE id=?').bind(guard));
  statements.push(db.prepare('DELETE FROM trash_write_guards WHERE id=?').bind(guard));
  let selectedIds: string[];
  let logicalCount = 0;
  try {
    const result = await db.batch(statements);
    logicalCount = Number((result[1]!.results[0] as { n: number } | undefined)?.n ?? 0);
    selectedIds = JSON.parse((result.at(-2)!.results[0] as { ids: string }).ids);
  } catch (error) {
    const message = String(error);
    if (message.includes('TRASH_SESSION')) throw new HttpError(401, '会话已失效，请重新登录');
    if (message.includes('TRASH_ASSET_PERMISSION'))
      throw new HttpError(404, 'ids：照片不存在、已永久删除或无权操作，请重新同步', 'ids');
    throw new HttpError(503, '回收站：提交结果暂不可确认，请先刷新并重试同一操作');
  }
  if (operation === 'purge') {
    const work = runPurgeJobs(env, {
      ownerId: identity.id,
      assetIds: selected ?? selectedIds,
    }).catch(() => ({ processed: 0, completed: 0 }));
    if (ctx) ctx.waitUntil(work);
    else await work;
  }
  return deletion ? new Response(null, { status: 204 }) : Response.json({ count: logicalCount });
}
export async function assetStatistics(request: Request, db: D1Database, identity: Identity) {
  const params = new URL(request.url).searchParams;
  let where = "owner_id=? AND visibility='timeline'";
  const args: (string | number)[] = [identity.id];
  for (const key of params.keys())
    if (!['isTrashed', 'isFavorite', 'visibility'].includes(key))
      invalid(key, '此筛选暂不支持，请移除此字段');
  for (const key of ['isTrashed', 'isFavorite'])
    if (params.has(key) && !['true', 'false'].includes(params.get(key)!))
      invalid(key, '必须为 true 或 false');
  if (params.has('visibility') && params.get('visibility') !== 'timeline')
    invalid('visibility', '当前仅支持 timeline');
  where +=
    params.get('isTrashed') === 'true' ? ' AND deleted_at IS NOT NULL' : ' AND deleted_at IS NULL';
  if (params.has('isFavorite')) {
    where += ' AND favorite=?';
    args.push(params.get('isFavorite') === 'true' ? 1 : 0);
  }
  const n = (await db
    .prepare(`SELECT COUNT(*) n FROM assets WHERE ${where}`)
    .bind(...args)
    .first<{ n: number }>())!.n;
  return Response.json({ images: n, videos: 0, total: n });
}
export async function purgeStatus(request: Request, db: D1Database, identity: Identity) {
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) if (key !== 'after') invalid(key, '仅接受 after 分页字段');
  const after = query.get('after') ?? '';
  if (after && !/^[a-f0-9-]{36}$/i.test(after))
    invalid('after', '请使用上一页的 nextAfter，首次请省略');
  const jobs = await db
    .prepare(
      'SELECT asset_id,status,created_at FROM asset_purge_jobs WHERE owner_id=? AND asset_id>? ORDER BY asset_id LIMIT 21',
    )
    .bind(identity.id, after)
    .all<{ asset_id: string; status: string; created_at: string }>();
  const page = jobs.results.slice(0, 20);
  return Response.json({
    entries: page.map((row) => ({
      id: row.asset_id,
      status: row.status,
      createdAt: row.created_at,
    })),
    nextAfter: jobs.results.length > 20 ? page.at(-1)!.asset_id : null,
  });
}
