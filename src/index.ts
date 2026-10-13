import { errorResponse, jsonResponse } from './http/responses';
import { route } from './poc/routes';

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const { pathname } = new URL(request.url);

    if (pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return errorResponse('METHOD_NOT_ALLOWED', '此接口仅支持 GET 或 HEAD', 405, requestId, {
          Allow: 'GET, HEAD',
        });
      }

      // 存活检查不代表数据库可用或 Immich 兼容性已通过。
      const response = jsonResponse(
        {
          service: 'immich-cf',
          status: 'ok',
          version: env.APP_VERSION,
          stage: String(env.ENABLE_P1_POC) === 'true' ? 'p1-small-images-poc' : 'scaffold',
        },
        200,
        requestId,
      );
      return request.method === 'HEAD' ? new Response(null, response) : response;
    }

    if (String(env.ENABLE_P1_POC) === 'true') {
      const response = await route(request, env, requestId);
      if (response) return response;
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return errorResponse(
        'NOT_IMPLEMENTED',
        '此 Immich 接口尚未实现或实验入口未启用',
        501,
        requestId,
      );
    }

    return errorResponse('NOT_FOUND', '请求的接口不存在', 404, requestId);
  },
} satisfies ExportedHandler<Env>;
