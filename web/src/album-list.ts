import type { Album } from './api';

export type AlbumOrder = 'updated' | 'created' | 'name' | 'count';
const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export function albumList(items: Album[], query: string, order: AlbumOrder = 'updated') {
  const needle = query.trim().toLocaleLowerCase();
  return items
    .filter((album) =>
      `${album.albumName}\n${album.description}`.toLocaleLowerCase().includes(needle),
    )
    .sort((a, b) => {
      const difference =
        order === 'count'
          ? b.assetCount - a.assetCount
          : order === 'created'
            ? Date.parse(b.createdAt) - Date.parse(a.createdAt)
            : order === 'updated'
              ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
              : 0;
      return difference || names.compare(a.albumName, b.albumName) || a.id.localeCompare(b.id);
    });
}
