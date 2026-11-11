import { authenticate } from '../poc/auth';
import { HttpError } from '../poc/http';
import { accounts, changePassword, webBootstrap } from './accounts';
import { gallery, webMedia } from './gallery';
import { upload } from '../poc/assets';
import { sameOrigin } from './common';
import { downloads } from './downloads';
import { manageShares, sharedPhotos } from './shares';
import { unlockShare } from './share-access';
import { timeline } from './timeline';
import { photoMetadata } from './photo-metadata';
import { PhotoTimeError, photoTimeZone } from '../photo-time';
import { webAlbums, transferAlbums } from './album-organization';
import { photoArchive } from './archive';

export async function webRoute(
  request: Request,
  env: Env,
  requestId: string,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (
    !path.startsWith('/api/immich-cf/web/') &&
    !/^\/api\/immich-cf\/admin\/users(?:\/|$)/.test(path)
  )
    return null;
  const media = path.match(/^\/api\/immich-cf\/web\/assets\/([^/]+)\/(preview|download)$/);
  const metadata = path.match(/^\/api\/immich-cf\/web\/assets\/([^/]+)\/metadata(\/extract)?$/);
  const admin = path.match(
    /^\/api\/immich-cf\/admin\/users(?:\/([^/]+)(?:\/(reset-password|sessions))?)?$/,
  );
  const download = path.match(/^\/api\/immich-cf\/web\/downloads(?:\/([^/]+)(?:\/(archive))?)?$/);
  const share = path.match(/^\/api\/immich-cf\/web\/shares(?:\/([^/]+))?$/);
  const shared = path.match(
    /^\/api\/immich-cf\/web\/shared(?:\/assets\/([^/]+)\/(preview|download))?$/,
  );
  const unlock = path === '/api/immich-cf/web/shared/unlock';
  const webPath = path.slice('/api/immich-cf/web/'.length);
  let methods: string[] = [];
  if (metadata) methods = metadata[2] ? ['POST'] : ['GET'];
  else if (webPath === 'photo-metadata') methods = ['PATCH'];
  else if (webPath === 'archive') methods = ['PATCH'];
  else if (webPath === 'album-transfer') methods = ['POST'];
  else if (webPath === 'albums') methods = ['GET'];
  else if (unlock) methods = ['POST'];
  else if (shared || ['bootstrap', 'assets', 'timeline'].includes(webPath)) methods = ['GET'];
  else if (share) methods = share[1] ? ['DELETE', 'PATCH'] : ['GET', 'POST'];
  else if (download) {
    if (download[2]) methods = ['GET'];
    else methods = download[1] ? ['GET', 'DELETE'] : ['POST'];
  } else if (media) methods = ['GET', 'HEAD'];
  else if (['password', 'upload'].includes(webPath)) methods = ['POST'];
  else if (admin) {
    if (admin[2] === 'sessions') methods = ['DELETE'];
    else if (admin[2] === 'reset-password') methods = ['POST'];
    else methods = admin[1] ? ['PATCH'] : ['GET', 'POST'];
  }
  let response: Response;
  try {
    if (!methods.length) throw new HttpError(404, '请求的网页接口不存在');
    if (!methods.includes(request.method)) {
      response = Response.json(
        { message: `此接口仅支持 ${methods.join('、')}` },
        { status: 405, headers: { Allow: methods.join(', ') } },
      );
    } else if (unlock) {
      response = await unlockShare(request, env.IMMICH_CF_DB);
    } else if (shared) {
      response = await sharedPhotos(request, env, shared[1], shared[2], ctx);
    } else {
      const identity = await authenticate(request, env.IMMICH_CF_DB);
      if (metadata)
        response = await photoMetadata(request, env, identity, metadata[1], !!metadata[2]);
      else if (webPath === 'albums')
        response = await webAlbums(request, env.IMMICH_CF_DB, identity);
      else if (webPath === 'album-transfer')
        response = await transferAlbums(request, env.IMMICH_CF_DB, identity);
      else if (webPath === 'photo-metadata') response = await photoMetadata(request, env, identity);
      else if (webPath === 'archive')
        response = await photoArchive(request, env.IMMICH_CF_DB, identity);
      else if (share) response = await manageShares(request, env.IMMICH_CF_DB, identity, share[1]);
      else if (download)
        response = await downloads(request, env, identity, download[1], !!download[2], ctx);
      else if (admin) response = await accounts(request, env, identity);
      else if (media) response = await webMedia(request, env, identity, media[1]!, media[2]!, ctx);
      else if (webPath === 'upload') {
        sameOrigin(request);
        for (const key of new URL(request.url).searchParams.keys())
          throw new HttpError(400, `${key}：上传不接受查询参数，请移除`, key);
        let zone: string;
        try {
          zone = photoTimeZone(request.headers.get('x-immich-cf-time-zone') ?? 'UTC');
        } catch (error) {
          if (error instanceof PhotoTimeError) throw new HttpError(400, error.message, error.field);
          throw error;
        }
        response = await upload(request, env, identity, zone);
      } else if (webPath === 'password') response = await changePassword(request, env, identity);
      else if (webPath === 'assets') response = await gallery(request, env, identity);
      else if (webPath === 'timeline') response = await timeline(request, env, identity);
      else response = await webBootstrap(request, env, identity);
    }
  } catch (error) {
    if (error instanceof HttpError)
      response = Response.json(
        {
          message: error.message,
          ...(error.field ? { errors: [{ path: [error.field], message: error.message }] } : {}),
        },
        { status: error.status, headers: error.status === 429 ? { 'Retry-After': '60' } : {} },
      );
    else {
      console.error(JSON.stringify({ requestId, code: 'WEB_REQUEST_FAILED' }));
      response = Response.json({ message: '服务暂不可用，请稍后重试', requestId }, { status: 503 });
    }
  }
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Request-Id', requestId);
  if (shared || share || unlock) {
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  return response;
}
