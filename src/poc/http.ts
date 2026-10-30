export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

export function invalid(field: string, reason: string): never {
  throw new HttpError(400, `${field}：${reason}`, field);
}

export async function body(request: Request, allowEmpty = false): Promise<Record<string, unknown>> {
  const json = request.headers.get('content-type')?.toLowerCase().startsWith('application/json');
  if (!allowEmpty && !json) {
    throw new HttpError(415, 'Content-Type：请使用 application/json');
  }
  const reader = request.body?.getReader();
  if (!reader) return allowEmpty ? {} : invalid('请求体', '不能为空，请提供 JSON 对象');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 65536) {
      await reader.cancel();
      throw new HttpError(413, '请求体：最多 64 KiB，请减少提交内容');
    }
    chunks.push(value);
  }
  if (!length && allowEmpty) return {};
  if (!json) throw new HttpError(415, 'Content-Type：请使用 application/json');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalid('请求体', '必须为有效的 JSON 对象');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return invalid('请求体', '必须为 JSON 对象');
  return data as Record<string, unknown>;
}

export function strings(
  data: Record<string, unknown>,
  key: string,
  allowed?: readonly string[],
): string[] {
  const value = data[key];
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some((v) => typeof v !== 'string' || v.length > 160 || (allowed && !allowed.includes(v)))
  ) {
    return invalid(key, '必须为最多 1000 项的有效字符串数组，每项最多 160 字符');
  }
  return value as string[];
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function uuid7(): string {
  const prefix = Date.now().toString(16).padStart(12, '0');
  const random = crypto.randomUUID();
  return `${prefix.slice(0, 8)}-${prefix.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
}
