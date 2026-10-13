export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId,
      ...extraHeaders,
    },
  });
}

// 仅用于项目基础路由。Immich 的错误格式在 P0 契约冻结后由适配层实现。
export function errorResponse(
  code: string,
  message: string,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse({ code, message, requestId }, status, requestId, extraHeaders);
}
