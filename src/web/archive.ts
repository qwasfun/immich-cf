import type { Identity } from '../poc/auth';
import { archiveIds, commitArchive } from '../poc/archive';
import { body } from '../poc/http';
import { field, only, sameOrigin } from './common';

export async function photoArchive(request: Request, db: D1Database, identity: Identity) {
  sameOrigin(request);
  for (const key of new URL(request.url).searchParams.keys())
    field(key, '照片归档', '不接受查询参数，请移除后重试');
  const input = await body(request);
  only(input, ['ids', 'archived', 'version']);
  const ids = archiveIds(input.ids);
  if (typeof input.archived !== 'boolean')
    field('archived', '归档状态', '必须为 true 或 false，请选择归档或取消归档');
  if (typeof input.version !== 'string' || !/^\d{1,16}:\d{1,16}$/.test(input.version))
    field('version', '照片列表版本', '请刷新照片列表，核对所选照片后重试');
  const result = await commitArchive(db, identity, ids, input.archived, input.version);
  return Response.json({
    processed: ids.length,
    changed: result.changed,
    unchanged: ids.length - result.changed,
  });
}
