import { HttpError, invalid } from '../poc/http';

export function field(key: string, label: string, reason: string): never {
  throw new HttpError(400, `${label}：${reason}`, key);
}
export function only(input: Record<string, unknown>, keys: string[]) {
  for (const key of Object.keys(input))
    if (!keys.includes(key)) invalid(key, '此操作不接受该字段，请移除');
}
export function uuid(value: unknown, key = 'id'): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  )
    invalid(key, '请提供有效的 UUID v4');
  return value.toLowerCase();
}
export const encode = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
export function decode<T>(raw: string): T {
  try {
    if (raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
          c.charCodeAt(0),
        ),
      ),
    ) as T;
  } catch {
    return invalid('cursor', '分页游标无效，请刷新后从第一页重新加载');
  }
}
export function pageSize(params: URLSearchParams) {
  const value = params.get('limit') ?? '60';
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100)
    invalid('limit', '每页数量必须是 1～100 的整数');
  return Number(value);
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin)
    throw new HttpError(403, '请求来源无效，请回到当前网页重新操作');
}
