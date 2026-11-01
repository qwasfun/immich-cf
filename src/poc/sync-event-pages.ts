import type { Identity } from './auth';
import { assetDto, type Asset } from './assets';
import type { SyncLine } from './sync-lines';

const columns =
  'id,owner_id,checksum,media_type,created_at,file_created_at,file_modified_at,filename,width,height,favorite,visibility,duration,deleted_at,live_photo_video_id,sync_seq';
// Original metadata and internal R2 references are never loaded for an asset DTO.
export async function* libraryEventPages(
  db: D1Database,
  identity: Identity,
  types: string[],
  checkpoints: ReadonlyMap<string, string>,
  reset: boolean,
): AsyncGenerator<SyncLine[]> {
  const watermark = (await db
    .prepare('SELECT value FROM asset_sync_clock WHERE id=1')
    .first<{ value: number }>())!.value;
  const floor = (type: string) => (reset ? 0 : Number(checkpoints.get(type)?.split('|')[1] ?? 0));
  const event = (type: string, seq: unknown, data: unknown): SyncLine => ({
    type,
    ack: `${type}|${String(seq).padStart(20, '0')}`,
    data,
  });
  async function* query(
    type: string,
    sql: string,
    map: (row: Record<string, unknown>) => unknown,
    cursor = 'sync_seq',
    size = 5000,
  ): AsyncGenerator<SyncLine[]> {
    let after = floor(type);
    while (true) {
      const rows = await db
        .prepare(`${sql} LIMIT ${size}`)
        .bind(identity.id, after, watermark)
        .all<Record<string, unknown>>();
      if (!rows.results.length) return;
      yield rows.results.map((row) => event(type, row[cursor], map(row)));
      after = Number(rows.results.at(-1)![cursor]);
      if (rows.results.length < size) return;
    }
  }
  const asset = (row: Record<string, unknown>) => assetDto(row as unknown as Asset);
  if (types.includes('AssetsV2')) {
    yield* query(
      'AssetV2',
      `SELECT ${columns} FROM assets WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq`,
      asset,
    );
    yield* query(
      'AssetDeleteV1',
      'SELECT asset_id,sync_seq FROM asset_tombstones WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      (r) => ({ assetId: r.asset_id }),
    );
  }
  if (types.includes('AlbumAssetsV2')) {
    yield* query(
      'AlbumAssetCreateV2',
      `SELECT ${columns
        .split(',')
        .map((c) => 'a.' + c)
        .join(
          ',',
        )},l.sync_seq link_seq FROM album_assets l JOIN assets a ON a.id=l.asset_id WHERE l.owner_id=? AND l.sync_seq>? AND l.sync_seq<=? ORDER BY l.sync_seq`,
      asset,
      'link_seq',
    );
    yield* query(
      'AlbumAssetUpdateV2',
      `SELECT ${columns
        .split(',')
        .map((c) => 'a.' + c)
        .join(
          ',',
        )} FROM assets a WHERE a.owner_id=? AND a.sync_seq>? AND a.sync_seq<=? AND EXISTS(SELECT 1 FROM album_assets l WHERE l.asset_id=a.id AND l.owner_id=a.owner_id) ORDER BY a.sync_seq`,
      asset,
    );
  }
  if (types.includes('AlbumsV2')) {
    yield* query(
      'AlbumDeleteV1',
      'SELECT album_id,sync_seq FROM album_deletions WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      (r) => ({ albumId: r.album_id }),
    );
    yield* query(
      'AlbumV2',
      'SELECT * FROM albums WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      (r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        thumbnailAssetId: r.thumbnail_asset_id,
        order: r.sort_order,
        isActivityEnabled: false,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }),
      'sync_seq',
      100,
    );
  }
  if (types.includes('AlbumUsersV1')) {
    yield* query(
      'AlbumUserDeleteV1',
      'SELECT album_id,sync_seq FROM album_deletions WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      (r) => ({ albumId: r.album_id, userId: identity.id }),
    );
    yield* query(
      'AlbumUserV1',
      'SELECT id,created_seq FROM albums WHERE owner_id=? AND created_seq>? AND created_seq<=? ORDER BY created_seq',
      (r) => ({ albumId: r.id, userId: identity.id, role: 'owner' }),
      'created_seq',
    );
  }
  if (types.includes('AlbumToAssetsV1')) {
    yield* query(
      'AlbumToAssetDeleteV1',
      `SELECT d.album_id,d.asset_id,d.sync_seq FROM album_asset_deletions d WHERE d.owner_id=? AND d.sync_seq>? AND d.sync_seq<=? AND NOT EXISTS(SELECT 1 FROM album_assets l WHERE l.album_id=d.album_id AND l.asset_id=d.asset_id) ORDER BY d.sync_seq`,
      (r) => ({ albumId: r.album_id, assetId: r.asset_id }),
    );
    yield* query(
      'AlbumToAssetV1',
      'SELECT album_id,asset_id,sync_seq FROM album_assets WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      (r) => ({ albumId: r.album_id, assetId: r.asset_id }),
    );
  }
  if (types.includes('AssetMetadataV1')) {
    yield* query(
      'AssetMetadataDeleteV1',
      `SELECT t.asset_id,t.metadata_key,t.sync_seq FROM asset_metadata_tombstones t WHERE t.owner_id=? AND t.sync_seq>? AND t.sync_seq<=? AND NOT EXISTS(SELECT 1 FROM assets a,json_each(a.metadata) entry WHERE a.id=t.asset_id AND a.owner_id=t.owner_id AND json_extract(entry.value,'$.key')=t.metadata_key) ORDER BY t.sync_seq`,
      (r) => ({ assetId: r.asset_id, key: r.metadata_key }),
    );
    let after = floor('AssetMetadataV1');
    while (true) {
      const rows = await db
        .prepare(
          "SELECT id,metadata,sync_seq FROM assets WHERE owner_id=? AND metadata<>'[]' AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq LIMIT 500",
        )
        .bind(identity.id, after, watermark)
        .all<{ id: string; metadata: string; sync_seq: number }>();
      if (!rows.results.length) return;
      yield rows.results.flatMap((row) =>
        (JSON.parse(row.metadata) as { key: string; value: unknown }[]).map((entry) =>
          event('AssetMetadataV1', row.sync_seq, {
            assetId: row.id,
            key: entry.key,
            value: entry.value,
          }),
        ),
      );
      after = rows.results.at(-1)!.sync_seq;
      if (rows.results.length < 500) return;
    }
  }
}
