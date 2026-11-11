import { authenticate, type Identity } from '../poc/auth';
import { assetDetailDto, type Asset } from '../poc/assets';
import { HttpError, invalid } from '../poc/http';
import { decode, encode, pageSize, uuid } from './common';
import { galleryScope, galleryState, readGalleryState } from './gallery-scope';

interface Cursor {
  owner: string;
  view: string;
  album: string;
  version: string;
  time: number;
  id: string;
  query?: string;
  direction?: 'previous' | 'next';
}
interface Row extends Asset {
  sortTime: number;
}

export async function gallery(request: Request, env: Env, identity: Identity) {
  const params = new URL(request.url).searchParams;
  const scope = galleryScope(params, identity, ['cursor', 'limit', 'anchorTime', 'anchorId']);
  const { where, args, sort, ascending, album, view, queryKey } = scope;
  const db = env.IMMICH_CF_DB;
  const limit = pageSize(params);
  const raw = params.get('cursor');
  const cursor = raw ? decode<Cursor>(raw) : null;
  if (raw !== null && !cursor) invalid('cursor', '分页游标无效，请刷新后从第一页重新加载');
  if (
    cursor &&
    (cursor.owner !== identity.id ||
      cursor.view !== view ||
      cursor.album !== album ||
      (cursor.query ?? '') !== queryKey ||
      typeof cursor.version !== 'string' ||
      !/^\d+:\d+$/.test(cursor.version) ||
      !Number.isFinite(cursor.time) ||
      typeof cursor.id !== 'string' ||
      (cursor.direction !== undefined && !['previous', 'next'].includes(cursor.direction)))
  )
    invalid('cursor', '分页游标不属于当前账号或筛选，请刷新后重试');
  if (cursor) uuid(cursor.id, 'cursor');
  const anchorTime = params.get('anchorTime');
  const anchorId = params.has('anchorId') ? uuid(params.get('anchorId'), 'anchorId') : null;
  if (params.has('cursor') && (anchorTime !== null || anchorId))
    invalid('cursor/anchorTime', '分页与日期定位不能同时使用，请重新选择定位方式');
  if (anchorId && !anchorTime) invalid('anchorTime', '照片定位必须提供拍摄时间');
  if (
    anchorTime !== null &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(anchorTime) ||
      !Number.isFinite(Date.parse(anchorTime)) ||
      new Date(anchorTime).toISOString() !== anchorTime)
  )
    invalid('anchorTime', '请提供有效的 UTC ISO 拍摄时间');

  let pivot: { time: number; id: string } | null = null;
  let seekVersion: string | null = null;
  if (anchorTime) {
    const targetId =
      anchorId ??
      (ascending ? '00000000-0000-4000-8000-000000000000' : 'ffffffff-ffff-4fff-bfff-ffffffffffff');
    const [state, before, after, exact] = await db.batch([
      galleryState(db, identity, album),
      db
        .prepare(
          `SELECT a.id,${sort} time FROM assets a WHERE ${where}
        AND (${sort},a.id)<(julianday(?),?) ORDER BY ${sort} DESC,a.id DESC LIMIT 1`,
        )
        .bind(...args, anchorTime, targetId),
      db
        .prepare(
          `SELECT a.id,${sort} time FROM assets a WHERE ${where}
        AND (${sort},a.id)>=(julianday(?),?) ORDER BY ${sort} ASC,a.id ASC LIMIT 1`,
        )
        .bind(...args, anchorTime, targetId),
      db
        .prepare(`SELECT a.id,${sort} time FROM assets a WHERE ${where} AND a.id=? LIMIT 1`)
        .bind(...args, anchorId ?? ''),
    ]);
    seekVersion = readGalleryState(state!);
    const low = before!.results[0] as { time: number; id: string } | undefined;
    const high = after!.results[0] as typeof low;
    const time = Date.parse(anchorTime) / 86400000 + 2440587.5;
    const matching = exact!.results[0] as typeof low;
    if (matching) pivot = matching;
    else if (!low) pivot = high ?? null;
    else if (!high) pivot = low;
    else {
      const earlier = Math.abs(time - low.time),
        later = Math.abs(high.time - time);
      pivot = earlier < later || (earlier === later && !ascending) ? low : high;
    }
  }
  const previous = cursor?.direction === 'previous';
  const readAscending = previous ? !ascending : ascending;
  let condition = '';
  const position: (string | number)[] = [];
  if (cursor || pivot) {
    const p = cursor ?? pivot!;
    condition = ` AND (${sort},a.id)${cursor ? (readAscending ? '>' : '<') : ascending ? '>=' : '<='}(?,?)`;
    position.push(p.time, p.id);
  }
  const [state, result] = await db.batch([
    galleryState(db, identity, album),
    db
      .prepare(
        `SELECT a.*,${sort} sortTime FROM assets a WHERE ${where}${condition}
      ORDER BY ${sort} ${readAscending ? 'ASC' : 'DESC'},a.id ${readAscending ? 'ASC' : 'DESC'} LIMIT ?`,
      )
      .bind(...args, ...position, limit),
  ]);
  const version = readGalleryState(state!);
  if ((cursor && cursor.version !== version) || (seekVersion && seekVersion !== version))
    throw new HttpError(409, '照片列表：图库已变化，请重新定位后继续浏览', 'cursor');
  const page = result!.results as unknown as Row[];
  if (previous) page.reverse();
  const first = page[0],
    last = page.at(-1);
  let hasPrevious = false,
    hasNext = false;
  if (first && last) {
    const [current, edges] = await db.batch([
      galleryState(db, identity, album),
      db
        .prepare(
          `SELECT
        EXISTS(SELECT 1 FROM assets a WHERE ${where} AND (${sort},a.id)${ascending ? '<' : '>'}(?,?)) hasPrevious,
        EXISTS(SELECT 1 FROM assets a WHERE ${where} AND (${sort},a.id)${ascending ? '>' : '<'}(?,?)) hasNext`,
        )
        .bind(...args, first.sortTime, first.id, ...args, last.sortTime, last.id),
    ]);
    if (readGalleryState(current!) !== version)
      throw new HttpError(409, '照片列表：图库已变化，请重新定位后继续浏览', 'cursor');
    const edge = edges!.results[0] as { hasPrevious: number; hasNext: number };
    hasPrevious = !!edge.hasPrevious;
    hasNext = !!edge.hasNext;
  }
  await authenticate(request, db);
  const makeCursor = (row: Row, direction: 'previous' | 'next') =>
    encode({
      owner: identity.id,
      view,
      album,
      version,
      time: row.sortTime,
      id: row.id,
      query: queryKey,
      direction,
    });
  return Response.json({
    items: page.map((row) => ({
      ...assetDetailDto(row),
      tags: JSON.parse(row.tags || '[]'),
      rating: row.rating ?? null,
      bytes: row.bytes,
      previewPath: `/api/immich-cf/web/assets/${row.id}/preview`,
      downloadPath: `/api/immich-cf/web/assets/${row.id}/download`,
    })),
    version,
    previousCursor: hasPrevious && first ? makeCursor(first, 'previous') : null,
    nextCursor: hasNext && last ? makeCursor(last, 'next') : null,
  });
}
