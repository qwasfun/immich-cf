import type { Identity } from './auth';
import { type Asset, assetDto } from './assets';

type Event = { type: string; ack: string; data: unknown };
export const albumTypes = ['AlbumsV2', 'AlbumUsersV1', 'AlbumToAssetsV1', 'AlbumAssetsV2'];
export async function albumEvents(
  db: D1Database,
  identity: Identity,
  types: string[],
  checkpoints: ReadonlyMap<string, string>,
  reset = false,
) {
  const assets: Event[] = [],
    albums: Event[] = [];
  if (!types.some((type) => albumTypes.includes(type))) return { assets, albums };
  const watermark = (await db
    .prepare('SELECT value FROM asset_sync_clock WHERE id=1')
    .first<{ value: number }>())!.value;
  const floor = (type: string) => (reset ? 0 : Number(checkpoints.get(type)?.split('|')[1] ?? 0));
  const emit = (target: Event[], type: string, seq: number, data: unknown) =>
    target.push({ type, ack: `${type}|${String(seq).padStart(20, '0')}`, data });
  const bounds = (type: string) => [identity.id, floor(type), watermark];
  if (types.includes('AlbumAssetsV2')) {
    const creates = await db
      .prepare(
        `SELECT a.*,l.sync_seq link_seq FROM album_assets l JOIN assets a ON a.id=l.asset_id
      WHERE l.owner_id=? AND l.sync_seq>? AND l.sync_seq<=? ORDER BY l.sync_seq`,
      )
      .bind(...bounds('AlbumAssetCreateV2'))
      .all<Asset & { link_seq: number }>();
    for (const row of creates.results)
      emit(assets, 'AlbumAssetCreateV2', row.link_seq, assetDto(row));
    const updates = await db
      .prepare(
        `SELECT a.* FROM assets a WHERE a.owner_id=? AND a.sync_seq>? AND a.sync_seq<=?
      AND EXISTS(SELECT 1 FROM album_assets l WHERE l.asset_id=a.id AND l.owner_id=a.owner_id) ORDER BY a.sync_seq`,
      )
      .bind(...bounds('AlbumAssetUpdateV2'))
      .all<Asset>();
    for (const row of updates.results)
      emit(assets, 'AlbumAssetUpdateV2', row.sync_seq, assetDto(row));
  }
  if (types.includes('AlbumsV2')) {
    const removed = await db
      .prepare(
        'SELECT album_id,sync_seq FROM album_deletions WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      )
      .bind(...bounds('AlbumDeleteV1'))
      .all<{ album_id: string; sync_seq: number }>();
    for (const row of removed.results)
      emit(albums, 'AlbumDeleteV1', row.sync_seq, { albumId: row.album_id });
    const current = await db
      .prepare(
        'SELECT * FROM albums WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      )
      .bind(...bounds('AlbumV2'))
      .all<{
        id: string;
        name: string;
        description: string;
        thumbnail_asset_id: string | null;
        sort_order: string;
        created_at: string;
        updated_at: string;
        sync_seq: number;
      }>();
    for (const row of current.results)
      emit(albums, 'AlbumV2', row.sync_seq, {
        id: row.id,
        name: row.name,
        description: row.description,
        thumbnailAssetId: row.thumbnail_asset_id,
        order: row.sort_order,
        isActivityEnabled: false,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
  }
  if (types.includes('AlbumUsersV1')) {
    const removed = await db
      .prepare(
        'SELECT album_id,sync_seq FROM album_deletions WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      )
      .bind(...bounds('AlbumUserDeleteV1'))
      .all<{ album_id: string; sync_seq: number }>();
    for (const row of removed.results)
      emit(albums, 'AlbumUserDeleteV1', row.sync_seq, {
        albumId: row.album_id,
        userId: identity.id,
      });
    const current = await db
      .prepare(
        'SELECT id,created_seq FROM albums WHERE owner_id=? AND created_seq>? AND created_seq<=? ORDER BY created_seq',
      )
      .bind(...bounds('AlbumUserV1'))
      .all<{ id: string; created_seq: number }>();
    for (const row of current.results)
      emit(albums, 'AlbumUserV1', row.created_seq, {
        albumId: row.id,
        userId: identity.id,
        role: 'owner',
      });
  }
  if (types.includes('AlbumToAssetsV1')) {
    const removed = await db
      .prepare(
        `SELECT d.album_id,d.asset_id,d.sync_seq FROM album_asset_deletions d WHERE d.owner_id=? AND d.sync_seq>? AND d.sync_seq<=?
      AND NOT EXISTS(SELECT 1 FROM album_assets l WHERE l.album_id=d.album_id AND l.asset_id=d.asset_id) ORDER BY d.sync_seq`,
      )
      .bind(...bounds('AlbumToAssetDeleteV1'))
      .all<{ album_id: string; asset_id: string; sync_seq: number }>();
    for (const row of removed.results)
      emit(albums, 'AlbumToAssetDeleteV1', row.sync_seq, {
        albumId: row.album_id,
        assetId: row.asset_id,
      });
    const current = await db
      .prepare(
        'SELECT album_id,asset_id,sync_seq FROM album_assets WHERE owner_id=? AND sync_seq>? AND sync_seq<=? ORDER BY sync_seq',
      )
      .bind(...bounds('AlbumToAssetV1'))
      .all<{ album_id: string; asset_id: string; sync_seq: number }>();
    for (const row of current.results)
      emit(albums, 'AlbumToAssetV1', row.sync_seq, {
        albumId: row.album_id,
        assetId: row.asset_id,
      });
  }
  return { assets, albums };
}
