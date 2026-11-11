import type { Identity } from '../poc/auth';
import { HttpError, invalid } from '../poc/http';
import { uuid } from './common';
import { photoQuery, photoQueryParams, PhotoQueryError } from './gallery-query';
import { MemoryDateError, memoryContext, memoryDayRanges, memoryDate } from '../memory-date';
import { PhotoTimeError } from '../photo-time';
import { mapScope } from './map-scope';

export function galleryScope(params: URLSearchParams, identity: Identity, extras: string[]) {
  const view = params.get('view') ?? 'photos';
  const allowed = [
    'view',
    'albumId',
    'q',
    'from',
    'to',
    'type',
    'order',
    'tag',
    'rating',
    ...(view === 'memories' ? ['memoryDate', 'memoryYear', 'timeZone'] : []),
    ...(view === 'map' ? ['mapView', 'bounds'] : []),
    ...extras,
  ];
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
  const album = params.has('albumId') ? uuid(params.get('albumId'), 'albumId') : '';
  const location = view === 'map' ? mapScope(params) : null;
  const sourceView = location?.view ?? view;
  if (
    !['photos', 'archive', 'library', 'favorites', 'trash', 'album', 'memories', 'map'].includes(
      view,
    )
  )
    invalid('view', '请选择照片、归档、完整图库、收藏、回收站、相册、回忆或地图');
  if ((sourceView === 'album') !== !!album)
    invalid('view/albumId', '相册视图必须提供相册 ID；其他视图请移除相册 ID');
  let where = `a.owner_id=? AND a.media_type='IMAGE' AND a.visibility='timeline' AND a.deleted_at IS ${sourceView === 'trash' ? 'NOT ' : ''}NULL${sourceView === 'favorites' ? ' AND a.favorite=1' : ''}${album ? ' AND EXISTS(SELECT 1 FROM album_assets l WHERE l.album_id=? AND l.asset_id=a.id AND l.owner_id=a.owner_id)' : ''}`;
  const args: (string | number)[] = [identity.id, ...(album ? [album] : [])];
  let memoryKey = '';
  if (location) {
    where += ' AND ' + location.where;
    args.push(...location.args);
  }
  if (view === 'memories') {
    try {
      const context = memoryContext(params),
        year = params.get('memoryYear') ?? '';
      if (!/^[1-9]\d{0,3}$/.test(year) || Number(year) >= context.year)
        invalid('memoryYear', '回忆年份：请选择回忆日期之前的有效年份');
      let target: string;
      try {
        target = memoryDate(year.padStart(4, '0') + context.date.slice(4));
      } catch {
        invalid('memoryYear', '回忆年份：该年没有这个日期，请选择其他年份');
      }
      const ranges = memoryDayRanges(target, context.timeZone);
      where +=
        ' AND a.archived=0 AND ' +
        (ranges.length
          ? '(' +
            ranges
              .map(
                () =>
                  '(julianday(a.file_created_at)>=julianday(?) AND julianday(a.file_created_at)<julianday(?))',
              )
              .join(' OR ') +
            ')'
          : '0');
      for (const range of ranges) args.push(range.from, range.to);
      memoryKey =
        '&' +
        new URLSearchParams({
          memoryDate: context.date,
          memoryYear: year,
          timeZone: context.timeZone,
        });
    } catch (error) {
      if (error instanceof MemoryDateError || error instanceof PhotoTimeError)
        throw new HttpError(400, error.message, error.field);
      throw error;
    }
  }
  if (sourceView === 'archive') where += ' AND a.archived=1';
  else if (sourceView === 'photos' && !query.q && !query.tag && query.rating === 'all')
    where += ' AND a.archived=0';
  if (query.tag) {
    where +=
      ' AND EXISTS(SELECT 1 FROM photo_tag_index t WHERE t.asset_id=a.id AND t.owner_id=a.owner_id AND t.tag_key=?)';
    args.push(query.tag);
  }
  if (query.rating === 'none') where += ' AND a.rating IS NULL';
  else if (query.rating !== 'all') {
    where += query.rating.startsWith('gte') ? ' AND a.rating>=?' : ' AND a.rating=?';
    args.push(Number(query.rating.replace('gte', '')));
  }
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
    queryKey: photoQueryParams(query).toString() + memoryKey + (location ? '&' + location.key : ''),
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
