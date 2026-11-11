import type { Identity } from '../poc/auth';
import { HttpError, invalid } from '../poc/http';
import { uuid } from './common';
import { photoQuery, photoQueryParams, PhotoQueryError } from './gallery-query';

export function galleryScope(params: URLSearchParams, identity: Identity, extras: string[]) {
  const allowed = ['view', 'albumId', 'q', 'from', 'to', 'type', 'order', ...extras];
  for (const key of params.keys()) {
    if (!allowed.includes(key)) invalid(key, '此查询参数不受支持，请移除');
    if (params.getAll(key).length !== 1) invalid(key, '请只提供一个值');
  }
  let query;
  try {
    query = photoQuery(params);
  } catch (error) {
    if (error instanceof PhotoQueryError) throw new HttpError(400, error.message, error.field);
    throw error;
  }
  const view = params.get('view') ?? 'photos';
  const album = params.has('albumId') ? uuid(params.get('albumId'), 'albumId') : '';
  if (!['photos', 'favorites', 'trash', 'album'].includes(view))
    invalid('view', '请选择全部照片、收藏、回收站或相册');
  if ((view === 'album') !== !!album)
    invalid('view/albumId', '相册视图必须提供相册 ID；其他视图请移除相册 ID');
  let where = `a.owner_id=? AND a.media_type='IMAGE' AND a.visibility='timeline' AND a.deleted_at IS ${view === 'trash' ? 'NOT ' : ''}NULL${view === 'favorites' ? ' AND a.favorite=1' : ''}${album ? ' AND EXISTS(SELECT 1 FROM album_assets l WHERE l.album_id=? AND l.asset_id=a.id AND l.owner_id=a.owner_id)' : ''}`;
  const args: (string | number)[] = [identity.id, ...(album ? [album] : [])];
  if (query.q) {
    where += " AND a.filename LIKE ? ESCAPE '\\'";
    args.push('%' + query.q.replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (query.from) {
    where += ' AND julianday(a.file_created_at)>=julianday(?)';
    args.push(query.from);
  }
  if (query.to) {
    where += ' AND julianday(a.file_created_at)<julianday(?)';
    args.push(query.to);
  }
  if (query.type === 'live' || query.type === 'static')
    where += ` AND a.live_photo_video_id IS ${query.type === 'live' ? 'NOT ' : ''}NULL`;
  else if (query.type !== 'all') {
    where += ' AND a.mime=?';
    args.push('image/' + query.type);
  }
  return {
    where,
    args,
    view,
    album,
    queryKey: photoQueryParams(query).toString(),
    ascending: query.order === 'oldest',
    sort: view === 'trash' ? 'julianday(a.deleted_at)' : 'julianday(a.file_created_at)',
  };
}

export function galleryState(db: D1Database, identity: Identity, album: string) {
  return db
    .prepare(
      `SELECT
    COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=?),0)||':'||
    COALESCE((SELECT revision FROM album_owner_revisions WHERE owner_id=?),0) version,
    (?='' OR EXISTS(SELECT 1 FROM albums WHERE id=? AND owner_id=?)) allowed`,
    )
    .bind(identity.id, identity.id, album, album, identity.id);
}

export function readGalleryState(result: D1Result) {
  const state = result.results[0] as { version: string; allowed: number };
  if (!state.allowed) throw new HttpError(404, '相册：不存在或无权访问，请刷新相册列表', 'albumId');
  return state.version;
}
