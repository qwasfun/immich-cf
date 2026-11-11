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
  q: '文件名',
  from: '拍摄开始时间',
  to: '拍摄结束时间',
  type: '照片类型',
  order: '排序',
  assetData: '照片文件',
  filename: '文件名',
  fileCreatedAt: '照片时间',
  fileModifiedAt: '文件修改时间',
  livePhotoVideoId: '动态照片配对',
  visibility: '照片类型',
  'x-immich-checksum': '文件校验',
  albumId: '相册',
  sourceAlbumId: '来源相册',
  targetAlbumId: '目标相册',
  mode: '整理方式',
  archived: '归档状态',
  downloadId: '下载任务',
  attempt: '下载尝试',
  days: '有效期',
  shareId: '分享链接',
  allowDownload: '允许下载原件',
  component: '原件类型',
  timeZone: '拍摄时区',
  dateTime: '拍摄时间',
  shiftMinutes: '整体偏移',
  occurrence: '重复时刻',
  latitude: '纬度',
  longitude: '经度',
  version: '照片资料版本',
};
function readable(message: string) {
  return message.replace(/^([a-zA-Z/-]+)([：:])/, (all, key: string) => {
    const keys = key.split('/');
    return keys.every((key) => labels[key])
      ? keys.map((key) => labels[key]).join('、') + '：'
      : all;
  });
}
export function responseError(error: unknown, status: number, url: string): ApiError {
  const body = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const messages = Array.isArray(body.errors)
    ? body.errors
        .map((entry: { message?: string; path?: string[] }) => {
          const message = String(entry?.message ?? '');
          const field = Array.isArray(entry?.path) ? entry.path[0] : undefined;
          return message &&
            field &&
            labels[field] &&
            !message.includes('：') &&
            !message.includes(':')
            ? `${labels[field]}：${message}`
            : message;
        })
        .filter(Boolean)
    : [];
  const message = [
    ...new Set(
      messages.length ? messages : [body.message || `请求未完成（${status}），请稍后重试`],
    ),
  ]
    .map((message) => readable(String(message)))
    .join('；');
  if (status === 401 && url !== '/api/auth/login' && !url.startsWith('/api/immich-cf/web/shared'))
    window.dispatchEvent(new CustomEvent('session-expired', { detail: message }));
  return new ApiError(message, status);
}
export async function api<T = unknown>(
  url: string,
  method = 'GET',
  data?: unknown,
  signal?: AbortSignal,
  blob: boolean | 'attachment' = false,
  shareToken?: string,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = window.setTimeout(cancel, blob === 'attachment' ? 300000 : 30000);
  try {
    const response = await fetch(url, {
      method,
      credentials: shareToken ? 'omit' : 'same-origin',
      cache: 'no-store',
      headers: {
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(shareToken ? { Authorization: 'Share ' + shareToken } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw responseError(error, response.status, url);
    }
    if (response.status === 204) return undefined as T;
    if (blob === 'attachment') {
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const fallback = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? '照片原件';
      return {
        data: await response.blob(),
        name: encoded ? decodeURIComponent(encoded) : fallback,
      } as T;
    }
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
export interface Attachment {
  data: Blob;
  name: string;
}
export interface Photo {
  id: string;
  originalFileName: string;
  fileCreatedAt: string;
  width: number;
  height: number;
  isFavorite: boolean;
  isArchived: boolean;
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
  previousCursor?: string | null;
  version?: string;
}
export interface Album {
  id: string;
  albumName: string;
  description: string;
  albumThumbnailAssetId: string | null;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface Bootstrap {
  user: { id: string; email: string; name: string };
  canManageAccounts: boolean;
  usage: { logicalAssets: number; logicalBytes: number; photos: number; trashed: number };
  limits: { assetLimit: number; upload: UploadLimits };
}
export interface UploadLimits {
  photoBytes: number;
  motionBytes: number;
  photoExtensions: string[];
  maxPixels: number;
  maxEdge: number;
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
