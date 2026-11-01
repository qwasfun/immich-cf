export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const labels: Record<string, string> = {
  email: '邮箱',
  password: '密码',
  albumName: '相册名称',
  description: '相册描述',
  currentPassword: '旧密码',
  newPassword: '新密码',
  name: '显示名称',
  ids: '所选照片',
  assetIds: '所选照片',
  id: '项目',
  cursor: '分页',
  size: '预览尺寸',
};
function readable(message: string) {
  return message.replace(/^([a-zA-Z]+)([：:])/, (all, key: string) =>
    labels[key] ? labels[key] + '：' : all,
  );
}
export async function api<T = unknown>(
  url: string,
  method = 'GET',
  data?: unknown,
  signal?: AbortSignal,
  blob = false,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = window.setTimeout(cancel, 30000);
  try {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const messages = Array.isArray(error.errors)
        ? error.errors.map((e: { message?: string }) => e.message).filter(Boolean)
        : [];
      const message = [
        ...new Set(
          messages.length
            ? messages
            : [error.message || `请求未完成（${response.status}），请稍后重试`],
        ),
      ]
        .map((m) => readable(String(m)))
        .join('；');
      if (response.status === 401 && url !== '/api/auth/login')
        window.dispatchEvent(new CustomEvent('session-expired', { detail: message }));
      throw new ApiError(message, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (blob ? await response.blob() : await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error('网络连接中断或请求超时，请重试；涉及修改时请先刷新确认结果');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
export interface Photo {
  id: string;
  originalFileName: string;
  fileCreatedAt: string;
  width: number;
  height: number;
  isFavorite: boolean;
  isTrashed: boolean;
  deletedAt: string | null;
  originalMimeType: string;
  bytes: number;
  livePhotoVideoId: string | null;
  previewPath: string;
  downloadPath: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  version?: string;
}
export interface Album {
  id: string;
  albumName: string;
  description: string;
  albumThumbnailAssetId: string | null;
  assetCount: number;
}
export interface Bootstrap {
  user: { id: string; email: string; name: string };
  canManageAccounts: boolean;
  usage: { logicalAssets: number; logicalBytes: number; photos: number; trashed: number };
  limits: { assetLimit: number };
}
export interface Account {
  id: string;
  email: string;
  name: string;
  disabled: number;
  isOperator: number;
  logicalAssets: number;
  logicalBytes: number;
  trashed: number;
  sessions: number;
  assetLimit: number;
  createdAt: string;
}
export const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1073741824
        ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(2)} GB`;
export const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export const web = '/api/immich-cf/web';
export interface Membership {
  id: string;
  success: boolean;
  error?: string;
  errorMessage?: string;
}
export async function albumMembers(id: string, ids: string[], method: 'PUT' | 'DELETE') {
  const rows = await api<Membership[]>(`/api/albums/${id}/assets`, method, { ids });
  const unexpected = rows.filter(
    (row) => !row.success && row.error !== (method === 'PUT' ? 'duplicate' : 'not_found'),
  );
  if (unexpected.length)
    throw new Error(
      unexpected
        .map((row) => readable(row.errorMessage ?? '相册：部分照片未能处理，请刷新后重试'))
        .join('；'),
    );
  const success = rows.filter((row) => row.success).length,
    skipped = rows.length - success;
  return method === 'PUT'
    ? `${success} 张照片已加入相册${skipped ? `；另有 ${skipped} 张照片已在相册中` : ''}`
    : `${success} 张照片已移出相册${skipped ? `；另有 ${skipped} 张照片原本已不在此相册中` : ''}`;
}
