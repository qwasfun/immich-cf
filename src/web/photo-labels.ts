import { authenticate, type Identity } from '../poc/auth';
import { body, HttpError } from '../poc/http';
import { archiveIds } from '../poc/archive';
import { photoTags, photoRating, tagKey, PhotoLabelError } from '../photo-labels';
import { field, only, sameOrigin } from './common';
import { galleryState, readGalleryState } from './gallery-scope';

interface Row {
  id: string;
  tags: string;
  rating: number | null;
}
async function snapshot(db: D1Database, identity: Identity, ids: string[]) {
  const [state, rows] = await db.batch([
    galleryState(db, identity, ''),
    db
      .prepare(
        "SELECT id,tags,rating FROM assets WHERE owner_id=? AND media_type='IMAGE' AND visibility='timeline' AND deleted_at IS NULL AND id IN(SELECT value FROM json_each(?)) ORDER BY id",
      )
      .bind(identity.id, JSON.stringify(ids)),
  ]);
  if (rows!.results.length !== ids.length)
    throw new HttpError(404, '所选照片：存在已删除或无权访问的项目，请刷新后重新选择', 'ids');
  return { version: readGalleryState(state!), rows: rows!.results as unknown as Row[] };
}
export async function tagSuggestions(request: Request, db: D1Database, identity: Identity) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys())
    if (key !== 'q' || params.getAll(key).length !== 1)
      field(key, '标签查找', '只接受单个 q 参数，请移除其他参数');
  const q = (params.get('q') ?? '').normalize('NFKC').trim();
  if (Array.from(q).length > 32 || /[\x00-\x1f\x7f]/.test(q))
    field('q', '标签查找', '最多填写 32 个字符，不能包含控制字符');
  const result = await db
    .prepare(
      `SELECT MIN(t.name) name,COUNT(*) count FROM photo_tag_index t JOIN assets a ON a.id=t.asset_id AND a.owner_id=t.owner_id
    WHERE t.owner_id=? AND a.media_type='IMAGE' AND a.visibility='timeline' AND a.deleted_at IS NULL AND t.tag_key LIKE ? ESCAPE '\\'
    GROUP BY t.tag_key ORDER BY count DESC,t.tag_key LIMIT 51`,
    )
    .bind(identity.id, '%' + tagKey(q).replace(/[\\%_]/g, '\\$&') + '%')
    .all();
  await authenticate(request, db);
  return Response.json({ items: result.results.slice(0, 50), hasMore: result.results.length > 50 });
}
export async function labels(
  request: Request,
  db: D1Database,
  identity: Identity,
  inspect = false,
) {
  sameOrigin(request);
  for (const key of new URL(request.url).searchParams.keys())
    field(key, '标签与评分', '不接受查询参数，请移除后重试');
  const input = await body(request);
  only(input, inspect ? ['ids'] : ['ids', 'version', 'tagAction', 'tags', 'rating']);
  const ids = archiveIds(input.ids);
  let tags: string[] | undefined, rating: number | null | undefined;
  try {
    if (Object.hasOwn(input, 'rating')) rating = photoRating(input.rating);
    if (input.tagAction !== undefined) {
      if (
        typeof input.tagAction !== 'string' ||
        !['add', 'remove', 'replace', 'clear'].includes(input.tagAction)
      )
        field('tagAction', '标签操作', '请选择追加、移除、替换或清空');
      tags = photoTags(input.tags === undefined ? [] : input.tags);
      if (['add', 'remove'].includes(input.tagAction) && !tags.length)
        field('tags', '标签', '追加或移除时请至少填写 1 项');
      if (input.tagAction === 'clear' && tags.length)
        field('tags', '标签', '清空操作不能同时填写标签，请先移除输入项');
    } else if (input.tags !== undefined)
      field('tagAction', '标签操作', '请指定追加、移除或替换方式');
  } catch (error) {
    if (error instanceof PhotoLabelError) throw new HttpError(400, error.message, error.field);
    throw error;
  }
  if (!inspect && input.tagAction === undefined && !Object.hasOwn(input, 'rating'))
    field('tags/rating', '标签、评分', '请至少修改一项');
  if (!inspect && (typeof input.version !== 'string' || !/^\d{1,16}:\d{1,16}$/.test(input.version)))
    field('version', '照片列表版本', '请刷新编辑窗口，核对后重新保存');
  const found = await snapshot(db, identity, ids);
  if (inspect) {
    const first = photoTags(JSON.parse(found.rows[0]!.tags)),
      common = first.filter((name) =>
        found.rows.every((row) =>
          JSON.parse(row.tags).some((other: string) => tagKey(other) === tagKey(name)),
        ),
      );
    await authenticate(request, db);
    return Response.json({
      version: found.version,
      count: ids.length,
      commonTags: common,
      rating: found.rows[0]!.rating,
      ratingMixed: found.rows.some((row) => row.rating !== found.rows[0]!.rating),
    });
  }
  if (found.version !== input.version)
    throw new HttpError(409, '标签与评分：图库已变化，请刷新编辑窗口，核对后重新保存', 'version');
  const changes = found.rows
    .map((row) => {
      let next = photoTags(JSON.parse(row.tags));
      if (input.tagAction === 'clear') next = [];
      else if (input.tagAction === 'replace') next = tags!;
      else if (input.tagAction === 'add') {
        const known = new Set(next.map(tagKey));
        next = [...next, ...tags!.filter((name) => !known.has(tagKey(name)))];
      } else if (input.tagAction === 'remove') {
        const removed = new Set(tags!.map(tagKey));
        next = next.filter((name) => !removed.has(tagKey(name)));
      }
      try {
        next = photoTags(next);
      } catch (error) {
        if (error instanceof PhotoLabelError)
          throw new HttpError(
            400,
            '标签：部分照片追加后会超过 20 项，请减少追加标签或先移除旧标签',
            'tags',
          );
        throw error;
      }
      return {
        id: row.id,
        tags: JSON.stringify(next),
        rating: rating === undefined ? row.rating : rating,
      };
    })
    .filter((change, index) => {
      const row = found.rows[index]!;
      return row.tags !== change.tags || row.rating !== change.rating;
    });
  const guard = crypto.randomUUID(),
    statements = [
      db
        .prepare('INSERT INTO photo_label_guards VALUES(?,?,?,?,?,?)')
        .bind(
          guard,
          identity.id,
          identity.session_id,
          JSON.stringify(ids),
          found.version,
          Date.now(),
        ),
    ];
  for (let at = 0; at < changes.length; at += 50)
    statements.push(
      db
        .prepare(
          `WITH updates AS MATERIALIZED (SELECT json_extract(value,'$.id') id,json_extract(value,'$.tags') tags,json_extract(value,'$.rating') rating FROM json_each(?))
    UPDATE assets AS a SET tags=(SELECT tags FROM updates WHERE id=a.id),rating=(SELECT rating FROM updates WHERE id=a.id)
    WHERE owner_id=? AND id IN(SELECT id FROM updates) AND EXISTS(SELECT 1 FROM photo_label_guards WHERE id=?)`,
        )
        .bind(JSON.stringify(changes.slice(at, at + 50)), identity.id, guard),
    );
  statements.push(db.prepare('DELETE FROM photo_label_guards WHERE id=?').bind(guard));
  try {
    await db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes('LABEL_SESSION'))
      throw new HttpError(401, '登录会话：已失效，请重新登录后设置标签与评分');
    if (message.includes('LABEL_VERSION'))
      throw new HttpError(409, '标签与评分：图库已变化，请刷新编辑窗口，核对后重新保存', 'version');
    if (message.includes('LABEL_SCOPE'))
      throw new HttpError(404, '所选照片：存在已删除或无权访问的项目，请刷新后重新选择', 'ids');
    throw new HttpError(503, '标签与评分：提交结果暂不可确认，请先刷新核对，再决定是否重试');
  }
  return Response.json({
    processed: ids.length,
    changed: changes.length,
    unchanged: ids.length - changes.length,
  });
}
