import type { Identity } from './auth';
import type { Asset } from './assets';
import { HttpError, invalid } from './http';

export function archiveIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    invalid('ids', '请选择 1～1000 张照片，超过上限请分批操作');
  return [
    ...new Set(
      value.map((id) => {
        if (
          typeof id !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)
        )
          invalid('ids', '请选择有效的照片 ID，刷新列表后重新选择');
        return id.toLowerCase();
      }),
    ),
  ];
}

export async function commitArchive(
  db: D1Database,
  identity: Identity,
  ids: string[],
  archived: boolean,
  version = '',
  favorite?: boolean,
) {
  const guard = crypto.randomUUID(),
    encoded = JSON.stringify(ids),
    flag = archived ? 1 : 0,
    mark = favorite === undefined ? null : favorite ? 1 : 0;
  try {
    const result = await db.batch([
      db
        .prepare('INSERT INTO photo_archive_guards VALUES(?,?,?,?,?,?)')
        .bind(guard, identity.id, identity.session_id, encoded, version, Date.now()),
      db
        .prepare(
          `UPDATE assets SET archived=?,favorite=COALESCE(?,favorite)
        WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))
        AND EXISTS(SELECT 1 FROM photo_archive_guards WHERE id=?) AND (archived<>? OR (? IS NOT NULL AND favorite<>?)) RETURNING id`,
        )
        .bind(flag, mark, identity.id, encoded, guard, flag, mark, mark),
      db
        .prepare(
          'SELECT * FROM assets WHERE owner_id=? AND id IN(SELECT value FROM json_each(?)) ORDER BY id',
        )
        .bind(identity.id, encoded),
      db.prepare('DELETE FROM photo_archive_guards WHERE id=?').bind(guard),
    ]);
    return { changed: result[1]!.results.length, rows: result[2]!.results as unknown as Asset[] };
  } catch (error) {
    const message = String(error);
    if (message.includes('ARCHIVE_SESSION'))
      throw new HttpError(401, '登录会话：已失效，请重新登录后整理归档');
    if (message.includes('ARCHIVE_VERSION'))
      throw new HttpError(
        409,
        '照片归档：图库已变化，请刷新列表，核对所选照片后重新操作',
        'version',
      );
    if (message.includes('ARCHIVE_SCOPE'))
      throw new HttpError(
        404,
        '所选照片：存在已删除、无权访问或不能归档的项目，请刷新后重新选择',
        'ids',
      );
    throw new HttpError(503, '照片归档：提交结果暂不可确认，请先刷新列表核对，再决定是否重试');
  }
}
