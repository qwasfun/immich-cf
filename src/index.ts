import { errorResponse, jsonResponse } from './http/responses';
import { runPurgeJobs } from './poc/purge';
import { route } from './poc/routes';
import { runPreviews } from './poc/previews';
import { cleanStaging } from './poc/media-staging';
import { webRoute } from './web/routes';

export default {
  async scheduled(controller, env, ctx) {
    if (String(env.ENABLE_P1_POC) === 'true')
      ctx.waitUntil(
        Promise.all([runPreviews(env), cleanStaging(env)]).catch(() => {
          console.error(JSON.stringify({ code: 'MEDIA_MAINTENANCE_UNAVAILABLE' }));
        }),
      );
    if (controller.cron && String(env.ENABLE_P1_POC) === 'true')
      ctx.waitUntil(
        runPurgeJobs(env)
          .then((result) => console.log(JSON.stringify({ code: 'PURGE_RUN_COMPLETE', ...result })))
          .catch(() => {
            console.error(JSON.stringify({ code: 'PURGE_RUN_UNAVAILABLE' }));
            throw new Error('PURGE_RUN_UNAVAILABLE');
          }),
      );
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
      const web = await webRoute(request, env, requestId, ctx);
      if (web) return web;
      const response = await route(request, env, requestId, ctx);
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

    if (
      String(env.ENABLE_P1_POC) === 'true' &&
      env.WEB_ASSETS &&
      ['GET', 'HEAD'].includes(request.method) &&
      (/^\/(?:login|photos|favorites|trash|account|admin\/users)?\/?$/.test(pathname) ||
        /^\/albums(?:\/[a-f0-9-]{36})?\/?$/.test(pathname) ||
        pathname.startsWith('/assets/') ||
        pathname === '/favicon.svg')
    ) {
      const asset = await env.WEB_ASSETS.fetch(request);
      if (
        pathname.startsWith('/assets/') &&
        asset.headers.get('Content-Type')?.includes('text/html')
      )
        return errorResponse('NOT_FOUND', '请求的静态文件不存在', 404, requestId);
      const response = new Response(asset.body, asset);
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'same-origin');
      response.headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      response.headers.set(
        'Cache-Control',
        pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      );
      return response;
    }
    return errorResponse('NOT_FOUND', '请求的接口不存在', 404, requestId);
  },
} satisfies ExportedHandler<Env>;
