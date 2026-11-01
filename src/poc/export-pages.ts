import { HttpError, invalid } from './http';

type Kind = 'assets' | 'albums' | 'relations' | 'complete';
interface Snapshot {
  assetRevision: number;
  albumRevision: number;
}
interface Totals {
  assets: number;
  albums: number;
  relations: number;
}
interface Cursor {
  version: 1;
  owner: string;
  snapshot: Snapshot;
  totals: Totals;
  exportedAt: string;
  kind: Kind;
  after: string[];
}
const sizes = { assets: 50, albums: 20, relations: 2000, complete: 0 };
const revisionSql = `SELECT COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=?),0) assetRevision,COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=?),0) albumRevision`;
const assetColumns =
  'id,filename,mime,bytes,checksum,width,height,file_created_at,file_modified_at,created_at,updated_at,deleted_at,favorite,metadata,sync_seq,media_type,visibility,duration,live_photo_video_id';
const bounds = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const encode = (cursor: Cursor) =>
  btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function decode(value: string, owner: string): Cursor {
  let c: Cursor;
  try {
    if (value.length > 2048 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw Error();
    c = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    if (
      c.version !== 1 ||
      c.owner !== owner ||
      !Object.hasOwn(sizes, c.kind) ||
      !Array.isArray(c.after) ||
      c.after.length !== (c.kind === 'relations' ? 2 : 1) ||
      c.after.some((v) => typeof v !== 'string' || (v !== '' && !/^[a-f0-9-]{36}$/.test(v))) ||
      !bounds(c.snapshot.assetRevision, Number.MAX_SAFE_INTEGER) ||
      !bounds(c.snapshot.albumRevision, Number.MAX_SAFE_INTEGER) ||
      !bounds(c.totals.assets, 20000) ||
      !bounds(c.totals.albums, 100) ||
      !bounds(c.totals.relations, 1000000) ||
      typeof c.exportedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(c.exportedAt)
    )
      throw Error();
  } catch {
    invalid('cursor', '导出游标无效或不属于此账号，请从第一页重新导出');
  }
  return c;
}
export async function exportPage(
  request: Request,
  db: D1Database,
  owner: string,
  authorize: () => Promise<void>,
) {
  const raw = new URL(request.url).searchParams.get('cursor');
  let cursor = raw === null ? undefined : decode(raw, owner);
  const kind = cursor?.kind ?? 'assets',
    after = cursor?.after ?? [''];
  let query: D1PreparedStatement;
  if (kind === 'assets')
    query = db
      .prepare(`SELECT ${assetColumns} FROM assets WHERE owner_id=? AND id>? ORDER BY id LIMIT 51`)
      .bind(owner, after[0]);
  else if (kind === 'albums')
    query = db
      .prepare(
        'SELECT id,name,description,thumbnail_asset_id,sort_order,created_at,updated_at FROM albums WHERE owner_id=? AND id>? ORDER BY id LIMIT 21',
      )
      .bind(owner, after[0]);
  else if (kind === 'relations')
    query = db
      .prepare(
        'SELECT album_id,asset_id FROM album_assets WHERE owner_id=? AND (album_id,asset_id)>(?,?) ORDER BY album_id,asset_id LIMIT 2001',
      )
      .bind(owner, after[0], after[1]);
  else query = db.prepare('SELECT 1 WHERE 0');
  const results = await db.batch([
    db.prepare(revisionSql).bind(owner, owner),
    ...(cursor
      ? []
      : [
          db
            .prepare(
              `SELECT (SELECT COUNT(*) FROM assets WHERE owner_id=?) assets,(SELECT COUNT(*) FROM albums WHERE owner_id=?) albums,(SELECT COUNT(*) FROM album_assets WHERE owner_id=?) relations`,
            )
            .bind(owner, owner, owner),
        ]),
    query,
  ]);
  await authorize();
  const snapshot = results[0]!.results[0] as unknown as Snapshot;
  if (
    cursor &&
    (snapshot.assetRevision !== cursor.snapshot.assetRevision ||
      snapshot.albumRevision !== cursor.snapshot.albumRevision)
  )
    throw new HttpError(409, 'cursor：导出期间图库或相册关系已变化，请重新从第一页导出', 'cursor');
  if (!cursor) {
    const totals = results[1]!.results[0] as unknown as Totals;
    if (
      !bounds(totals.assets, 20000) ||
      !bounds(totals.albums, 100) ||
      !bounds(totals.relations, 1000000)
    )
      throw new HttpError(
        409,
        'userId：账号数据超出当前 10,000 项逻辑资产的导出范围，请先核对数据',
        'userId',
      );
    cursor = {
      version: 1,
      owner,
      snapshot,
      totals,
      kind: 'assets',
      after: [''],
      exportedAt: new Date().toISOString(),
    };
  }
  const rows = results.at(-1)!.results as Record<string, unknown>[],
    size = sizes[kind];
  const items = rows.slice(0, size);
  let next: Cursor | undefined;
  if (kind !== 'complete') {
    const more = rows.length > size;
    const nextKind: Kind = more
      ? kind
      : kind === 'assets'
        ? 'albums'
        : kind === 'albums'
          ? 'relations'
          : 'complete';
    const last = items.at(-1);
    next = {
      ...cursor,
      kind: nextKind,
      after: more
        ? kind === 'relations'
          ? [String(last!.album_id), String(last!.asset_id)]
          : [String(last!.id)]
        : nextKind === 'relations'
          ? ['', '']
          : [''],
    };
  }
  return Response.json({
    format: 'immich-cf-account-pages-v1',
    manifestFormat: 'immich-cf-account-v2',
    ownerId: owner,
    exportedAt: cursor.exportedAt,
    includesTrash: true,
    fullDatabaseBackup: false,
    snapshot: cursor.snapshot,
    totals: cursor.totals,
    page: {
      kind,
      items:
        kind === 'assets'
          ? items.map((a) => ({
              ...a,
              downloadPath: `/api/immich-cf/admin/export/original?userId=${owner}&id=${a.id}&revision=${a.sync_seq}`,
            }))
          : items,
      nextCursor: next ? encode(next) : null,
    },
  });
}
