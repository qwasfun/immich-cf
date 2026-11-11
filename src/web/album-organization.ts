import { authenticate, type Identity } from '../poc/auth';
import { albumDto, selectAlbum, type Album } from '../poc/albums';
import { body, HttpError } from '../poc/http';
import { field, only, sameOrigin, uuid } from './common';
import { galleryState, readGalleryState } from './gallery-scope';

export async function webAlbums(request: Request, db: D1Database, identity: Identity) {
  for (const key of new URL(request.url).searchParams.keys())
    field(key, '相册查询', '不接受查询参数，请移除后重试');
  const [state, rows] = await db.batch([
    galleryState(db, identity, ''),
    db
      .prepare(`${selectAlbum} WHERE b.owner_id=? ORDER BY b.created_at DESC,b.id`)
      .bind(identity.id),
  ]);
  await authenticate(request, db);
  return Response.json({
    version: readGalleryState(state!),
    items: (rows!.results as unknown as Album[]).map((row) => albumDto(row, identity)),
  });
}

export async function transferAlbums(request: Request, db: D1Database, identity: Identity) {
  sameOrigin(request);
  for (const key of new URL(request.url).searchParams.keys())
    field(key, '相册整理', '不接受查询参数，请移除后重试');
  const input = await body(request);
  only(input, ['ids', 'sourceAlbumId', 'targetAlbumId', 'mode', 'version']);
  const target = uuid(input.targetAlbumId, 'targetAlbumId'),
    source = input.sourceAlbumId === undefined ? '' : uuid(input.sourceAlbumId, 'sourceAlbumId');
  if (input.mode !== 'copy' && input.mode !== 'move') field('mode', '整理方式', '请选择复制或移动');
  const moving = input.mode === 'move';
  if (moving && !source) field('sourceAlbumId', '来源相册', '移动照片时必须选择来源相册');
  if (source === target) field('targetAlbumId', '目标相册', '不能与来源相册相同，请选择另一相册');
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 1000)
    field('ids', '所选照片', '请选择 1～1000 张照片，超过上限请分批操作');
  const ids = [...new Set(input.ids.map((id) => uuid(id, 'ids')))],
    encoded = JSON.stringify(ids);
  if (typeof input.version !== 'string' || !/^\d{1,16}:\d{1,16}$/.test(input.version))
    field('version', '相册列表版本', '请刷新目标相册列表，核对后重新提交');
  const guard = crypto.randomUUID();
  const statements = [
    db
      .prepare('INSERT INTO web_album_transfer_guards VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        guard,
        identity.id,
        identity.session_id,
        source,
        target,
        encoded,
        input.version,
        Date.now(),
      ),
    db
      .prepare(
        'SELECT COUNT(*) present FROM album_assets WHERE album_id=? AND asset_id IN(SELECT value FROM json_each(?))',
      )
      .bind(target, encoded),
    db
      .prepare(
        `INSERT INTO album_assets(album_id,asset_id,owner_id)
      SELECT ?,value,? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM web_album_transfer_guards WHERE id=?)
      ON CONFLICT(album_id,asset_id) DO NOTHING`,
      )
      .bind(target, identity.id, encoded, guard),
  ];
  if (moving)
    statements.push(
      db
        .prepare(
          `DELETE FROM album_assets WHERE album_id=? AND owner_id=? AND asset_id IN(SELECT value FROM json_each(?))
      AND EXISTS(SELECT 1 FROM web_album_transfer_guards WHERE id=?)`,
        )
        .bind(source, identity.id, encoded, guard),
    );
  statements.push(db.prepare('DELETE FROM web_album_transfer_guards WHERE id=?').bind(guard));
  try {
    const result = await db.batch(statements),
      present = Number((result[1]!.results[0] as { present: number }).present);
    return Response.json({
      processed: ids.length,
      added: ids.length - present,
      alreadyPresent: present,
      removed: moving ? ids.length : 0,
    });
  } catch (error) {
    const message = String(error);
    if (message.includes('TRANSFER_SESSION'))
      throw new HttpError(401, '登录会话：已失效，请重新登录后整理相册');
    if (message.includes('TRANSFER_TARGET'))
      throw new HttpError(404, '目标相册：不存在或无权访问，请刷新目标相册列表', 'targetAlbumId');
    if (message.includes('TRANSFER_SOURCE'))
      throw new HttpError(
        404,
        '来源相册：不存在或无权访问，请返回相册列表重新选择',
        'sourceAlbumId',
      );
    if (message.includes('TRANSFER_VERSION'))
      throw new HttpError(
        409,
        '相册整理：图库或相册已变化，请刷新目标相册列表，核对后重新提交',
        'version',
      );
    if (message.includes('TRANSFER_PHOTOS'))
      throw new HttpError(
        404,
        '所选照片：存在已删除、无权访问或已移出来源相册的照片，请刷新后重新选择',
        'ids',
      );
    throw new HttpError(503, '相册整理：提交结果暂不可确认，请先刷新相册列表核对，再决定是否重试');
  }
}
