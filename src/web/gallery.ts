import { authenticate, type Identity } from '../poc/auth';
import { type Asset, readAsset } from '../poc/assets';
import { HttpError, invalid } from '../poc/http';
import { queuePreviews, readPreview, runPreviews } from '../poc/previews';
import { uuid } from './common';
export { gallery } from './gallery-list';

export async function webMedia(
  request: Request,
  env: Env,
  identity: Identity,
  id: string,
  action: string,
  ctx?: ExecutionContext,
) {
  uuid(id);
  const params = new URL(request.url).searchParams;
  for (const key of params.keys())
    if (!(action === 'preview' ? ['size'] : ['component']).includes(key))
      invalid(key, '此查询参数不受支持，请移除');
  const row = await env.IMMICH_CF_DB.prepare(
    "SELECT * FROM assets WHERE id=? AND owner_id=? AND media_type='IMAGE' AND visibility='timeline'",
  )
    .bind(id, identity.id)
    .first<Asset>();
  if (!row) throw new HttpError(404, '照片：不存在或无权访问，请刷新图库');
  if (action === 'preview') {
    const size = params.get('size') ?? 'thumbnail';
    if (!['thumbnail', 'preview'].includes(size)) invalid('size', '请选择 thumbnail 或 preview');
    await queuePreviews(env, id);
    // Serve existing derivatives immediately; generation runs independently and is leased/budgeted.
    if (ctx) ctx.waitUntil(runPreviews(env, id).catch(() => undefined));
    else await runPreviews(env, id);
    const result = await readPreview(
      request,
      env,
      id,
      identity.id,
      size === 'thumbnail' ? 256 : 2048,
    );
    await authenticate(request, env.IMMICH_CF_DB);
    if (
      !(await env.IMMICH_CF_DB.prepare('SELECT id FROM assets WHERE id=? AND owner_id=?')
        .bind(id, identity.id)
        .first())
    ) {
      await result.body?.cancel();
      throw new HttpError(404, '照片已永久删除，请刷新图库');
    }
    return result;
  }
  const component = params.get('component') ?? 'photo';
  if (!['photo', 'motion'].includes(component)) invalid('component', '请选择 photo 或 motion');
  if (component === 'motion' && !row.live_photo_video_id)
    throw new HttpError(404, '动态视频：此照片没有已配对的 MOV 原件');
  const result = await readAsset(
    request,
    env,
    identity,
    component === 'motion' ? row.live_photo_video_id! : id,
    'original',
  );
  await authenticate(request, env.IMMICH_CF_DB);
  const extension =
    component === 'motion'
      ? 'mov'
      : row.mime === 'image/heic'
        ? 'heic'
        : row.mime === 'image/png'
          ? 'png'
          : 'jpg';
  result.headers.set(
    'Content-Disposition',
    `attachment; filename="${id}.${extension}"; filename*=UTF-8''${encodeURIComponent(component === 'motion' ? row.filename.replace(/\.[^.]*$/, '') + '.mov' : row.filename).replaceAll("'", '%27')}`,
  );
  return result;
}
