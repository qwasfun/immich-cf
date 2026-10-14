import { authenticate, cookies, login, userDto } from './auth';
import { HttpError } from './http';
import { sync } from './sync';
import { defaultPreferences } from './preferences';
import { sessions } from './sessions';
import { onboarding } from './onboarding';
import { upload, bulkCheck, readAsset } from './assets';
import { repairDimensions } from './repair-dimensions';

const methods: Record<string, string[]> = {
  '/api/immich-cf/repair-dimensions': ['POST'],
  '/api/assets': ['POST'],
  '/api/assets/bulk-upload-check': ['POST'],
  '/.well-known/immich': ['GET'],
  '/api/server/ping': ['GET'],
  '/api/server/version': ['GET'],
  '/api/server/features': ['GET'],
  '/api/server/config': ['GET'],
  '/api/server/media-types': ['GET'],
  '/api/auth/login': ['POST'],
  '/api/auth/logout': ['POST'],
  '/api/auth/validateToken': ['POST'],
  '/api/auth/status': ['GET'],
  '/api/users/me': ['GET'],
  '/api/users/me/preferences': ['GET', 'PUT'],
  '/api/users/me/onboarding': ['GET', 'PUT', 'DELETE'],
  '/api/sessions': ['GET', 'DELETE', 'POST'],
  '/api/sync/stream': ['POST'],
  '/api/sync/ack': ['GET', 'POST', 'DELETE'],
};

export async function route(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const assetPath = path.match(/^\/api\/assets\/([^/]+)(?:\/(original|thumbnail))?$/);
  const allowed =
    methods[path] ??
    (assetPath
      ? ['GET', 'HEAD']
      : /^\/api\/sessions\/[^/]+$/.test(path)
        ? ['DELETE', 'PUT']
        : undefined);
  if (!allowed) return null;
  let response: Response;
  try {
    if (!allowed.includes(request.method)) {
      response = Response.json(
        { message: `此接口仅支持 ${allowed.join('、')}` },
        { status: 405, headers: { Allow: allowed.join(', ') } },
      );
    } else {
      response = await dispatch(request, env, path);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      response = Response.json(
        {
          message: error.message,
          ...(error.field ? { errors: [{ path: [error.field], message: error.message }] } : {}),
        },
        { status: error.status, headers: error.status === 429 ? { 'Retry-After': '60' } : {} },
      );
    } else {
      // 不记录原始异常，避免 SQL 参数、Cookie、密码进入日志。
      console.error(JSON.stringify({ requestId, code: 'P1_REQUEST_FAILED' }));
      response = Response.json({ message: '服务暂不可用，请稍后重试', requestId }, { status: 503 });
    }
  }
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Request-Id', requestId);
  response.headers.set('X-Immich-Cf-Stage', 'p1-small-images-poc');
  return response;
}

async function dispatch(request: Request, env: Env, path: string): Promise<Response> {
  const db = env.IMMICH_CF_DB;
  if (path === '/.well-known/immich') return Response.json({ api: { endpoint: '/api' } });
  if (path === '/api/server/ping') return Response.json({ res: 'pong' });
  // Only static small JPEG/PNG files are supported by this experiment.
  if (path === '/api/server/media-types')
    return Response.json({ image: ['image/jpeg', 'image/png'], video: [], sidecar: [] });
  if (path === '/api/server/version')
    return Response.json({ major: 3, minor: 3, patch: 1, prerelease: null });
  if (path === '/api/server/features')
    return Response.json({
      configFile: false,
      duplicateDetection: false,
      email: false,
      facialRecognition: false,
      importFaces: false,
      map: false,
      oauth: false,
      oauthAutoLaunch: false,
      ocr: false,
      passwordLogin: true,
      realtimeTranscoding: false,
      reverseGeocoding: false,
      search: false,
      sidecar: false,
      smartSearch: false,
      trash: false,
    });
  if (path === '/api/server/config') {
    const initialized = !!(await db
      .prepare('SELECT id FROM users WHERE disabled = 0 LIMIT 1')
      .first());
    return Response.json({
      externalDomain: '',
      isInitialized: initialized,
      isOnboarded: initialized,
      loginPageMessage: 'immich-cf P1 小图片实验，尚未通过完整兼容验收',
      maintenanceMode: false,
      mapDarkStyleUrl: '',
      mapLightStyleUrl: '',
      minFaces: 1,
      oauthAccountManagementUrl: '',
      oauthButtonText: '',
      publicUsers: false,
      trashDays: 0,
      userDeleteDelay: 0,
    });
  }
  if (path === '/api/auth/login') {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin)
      throw new HttpError(403, '请求来源无效，请从当前服务重新操作');
    const { token, user } = await login(request, db);
    const response = Response.json(
      {
        accessToken: token,
        isAdmin: false,
        isOnboarded: true,
        name: user.name,
        profileImagePath: '',
        shouldChangePassword: false,
        userEmail: user.email,
        userId: user.id,
      },
      { status: 201 },
    );
    for (const cookie of cookies(request, token)) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  const identity = await authenticate(request, db);
  if (path === '/api/immich-cf/repair-dimensions') return repairDimensions(request, env, identity);
  if (path === '/api/assets') return upload(request, env, identity);
  if (path === '/api/assets/bulk-upload-check') return bulkCheck(request, db, identity);
  const assetPath = path.match(/^\/api\/assets\/([^/]+)(?:\/(original|thumbnail))?$/);
  if (assetPath) return readAsset(request, env, identity, assetPath[1]!, assetPath[2]);
  if (path === '/api/users/me/onboarding') return onboarding(request, db, identity);
  if (path === '/api/users/me/preferences') {
    if (request.method === 'PUT')
      throw new HttpError(501, '偏好设置：暂不支持保存，请保留默认设置');
    return Response.json(defaultPreferences());
  }
  if (path === '/api/sessions' || path.startsWith('/api/sessions/')) {
    if (request.method === 'POST' || request.method === 'PUT')
      throw new HttpError(501, '会话：暂不支持创建子会话或修改同步状态');
    return sessions(request, db, identity);
  }
  if (path === '/api/users/me') return Response.json(userDto(identity));
  if (path === '/api/auth/validateToken') return Response.json({ authStatus: true });
  if (path === '/api/auth/status')
    return Response.json({
      isElevated: false,
      password: true,
      pinCode: false,
      expiresAt: new Date(identity.expires_at).toISOString(),
    });
  if (path === '/api/auth/logout') {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(identity.session_id).run();
    const response = Response.json({ successful: true, redirectUri: '/' });
    for (const cookie of cookies(request, '', true)) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  return sync(request, db, identity);
}
