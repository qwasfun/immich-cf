import { authenticate } from '../poc/auth';
import { HttpError } from '../poc/http';
import { accounts, changePassword, webBootstrap } from './accounts';
import { gallery, webMedia } from './gallery';

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
  const admin = path.match(
    /^\/api\/immich-cf\/admin\/users(?:\/([^/]+)(?:\/(reset-password|sessions))?)?$/,
  );
  const methods =
    path === '/api/immich-cf/web/bootstrap' || path === '/api/immich-cf/web/assets'
      ? ['GET']
      : path === '/api/immich-cf/web/password'
        ? ['POST']
        : media
          ? ['GET', 'HEAD']
          : admin
            ? admin[2] === 'sessions'
              ? ['DELETE']
              : admin[2] === 'reset-password'
                ? ['POST']
                : admin[1]
                  ? ['PATCH']
                  : ['GET', 'POST']
            : [];
  let response: Response;
  try {
    if (!methods.length) throw new HttpError(404, '请求的网页接口不存在');
    if (!methods.includes(request.method)) {
      response = Response.json(
        { message: `此接口仅支持 ${methods.join('、')}` },
        { status: 405, headers: { Allow: methods.join(', ') } },
      );
    } else {
      const identity = await authenticate(request, env.IMMICH_CF_DB);
      response = admin
        ? await accounts(request, env, identity)
        : media
          ? await webMedia(request, env, identity, media[1]!, media[2]!, ctx)
          : path === '/api/immich-cf/web/password'
            ? await changePassword(request, env, identity)
            : path === '/api/immich-cf/web/assets'
              ? await gallery(request, env, identity)
              : await webBootstrap(request, env, identity);
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
  return response;
}
