import { ApiError, responseError, web } from './api';
import type { UploadLimits } from './api';

export const MAX_UPLOAD_ITEMS = 100;
export interface UploadEntry {
  id: string;
  file: File;
  motion?: File;
  motionId?: string;
  error: string;
}
export interface UploadResult {
  id: string;
  status: 'created' | 'duplicate';
}
export class UploadError extends ApiError {
  constructor(
    message: string,
    status = 0,
    public retryable = true,
  ) {
    super(message, status);
  }
}
const extension = (file: File) => file.name.split('.').at(-1)?.toLowerCase() ?? '';
const stem = (file: File) => file.name.replace(/\.[^.]*$/, '').toLowerCase();
function validate(file: File, limits: UploadLimits, motion = false): string {
  if (!file.name.trim() || file.name.length > 255 || /[\x00-\x1f\\/]/.test(file.name))
    return '文件名：请使用不含路径和控制字符的名称，最多 255 个字符';
  if (!file.size) return '照片文件：不能为空，请重新选择有内容的原件';
  if (
    motion
      ? !limits.motionBytes || extension(file) !== 'mov'
      : !limits.photoExtensions.includes(extension(file))
  )
    return `照片文件：请选择 ${limits.photoExtensions.join('、').toUpperCase()} 照片${limits.motionBytes ? '；MOV 必须与同名照片一起选择' : ''}`;
  const max = motion ? limits.motionBytes : limits.photoBytes;
  if (file.size > max)
    return `${motion ? '动态视频' : '照片文件'}：最多 ${max.toLocaleString('en-US')} 字节，请选择符合上限的原件`;
  return '';
}

// Filenames only suggest a pair. The server verifies the embedded pairing IDs.
export function uploadEntries(files: File[], limits: UploadLimits): UploadEntry[] {
  const groups = new Map<string, { photos: File[]; motions: File[] }>();
  for (const file of files) {
    if (extension(file) !== 'mov' && !limits.photoExtensions.includes(extension(file))) continue;
    const key = stem(file),
      group = groups.get(key) ?? { photos: [], motions: [] };
    (extension(file) === 'mov' ? group.motions : group.photos).push(file);
    groups.set(key, group);
  }
  const used = new Set<File>();
  return files.flatMap((file): UploadEntry[] => {
    if (used.has(file)) return [];
    used.add(file);
    const group = groups.get(stem(file));
    if (group?.motions.length && (extension(file) === 'mov' || group.photos.includes(file))) {
      if (group.photos.length === 1 && group.motions.length === 1 && limits.motionBytes) {
        const photo = group.photos[0]!,
          motion = group.motions[0]!;
        used.add(photo);
        used.add(motion);
        return [
          {
            id: crypto.randomUUID(),
            file: photo,
            motion,
            error: validate(photo, limits) || validate(motion, limits, true),
          },
        ];
      }
      return [
        {
          id: crypto.randomUUID(),
          file,
          error: '动态照片配对：请分批选择一张照片和一份同名 MOV 原件；独立视频暂不支持',
        },
      ];
    }
    return [{ id: crypto.randomUUID(), file, error: validate(file, limits) }];
  });
}

export type UploadProgress = (fraction: number, saving: boolean) => void;
type SendFile = typeof uploadFile;
export async function uploadEntry(
  entry: UploadEntry,
  progress: UploadProgress,
  signal: AbortSignal,
  savedMotion: (id: string) => void,
  send: SendFile = uploadFile,
): Promise<UploadResult> {
  const photoBytes = entry.file.size,
    motionBytes = entry.motion?.size ?? 0,
    total = photoBytes + motionBytes;
  let motionId = entry.motionId;
  if (entry.motion && !motionId) {
    const result = await send(
      entry.motion,
      { visibility: 'hidden' },
      (fraction, saving) => progress((fraction * motionBytes) / total, saving),
      signal,
    );
    motionId = result.id;
    savedMotion(motionId);
  }
  if (signal.aborted) throw new DOMException('已停止上传', 'AbortError');
  return send(
    entry.file,
    motionId ? { livePhotoVideoId: motionId } : {},
    (fraction, saving) => progress((motionBytes + fraction * photoBytes) / total, saving),
    signal,
  );
}

export async function uploadFile(
  file: File,
  fields: Record<string, string>,
  progress: UploadProgress,
  signal: AbortSignal,
): Promise<UploadResult> {
  if (signal.aborted) throw new DOMException('已停止上传', 'AbortError');
  if (!crypto.subtle)
    throw new UploadError('上传环境：请使用 HTTPS 网页或本机 localhost 地址后重试', 0, false);
  const checksum = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-1', await file.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  if (signal.aborted) throw new DOMException('已停止上传', 'AbortError');
  const modified = new Date(
    Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : Date.now(),
  );
  if (!Number.isFinite(modified.getTime()))
    throw new UploadError('文件修改时间：无效，请重新导出原件后选择', 400, false);
  const form = new FormData();
  form.append('assetData', file, file.name);
  form.append('fileCreatedAt', modified.toISOString());
  form.append('fileModifiedAt', modified.toISOString());
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const done = (error?: Error, result?: UploadResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result!);
    };
    const cancel = () => {
      xhr.abort();
      done(new DOMException('已停止上传', 'AbortError'));
    };
    xhr.open('POST', `${web}/upload`);
    xhr.withCredentials = true;
    xhr.timeout = 180000;
    xhr.setRequestHeader('x-immich-checksum', checksum);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(event.loaded / event.total, false);
    };
    xhr.upload.onload = () => progress(1, true);
    xhr.onerror = () =>
      done(new UploadError('照片文件：网络连接中断，请重试同一原件；相同内容不会重复保存'));
    xhr.ontimeout = () =>
      done(new UploadError('照片文件：上传或保存超时，请重试同一原件以确认结果'));
    xhr.onabort = () => done(new DOMException('已停止上传', 'AbortError'));
    xhr.onload = () => {
      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = responseError(
          body ?? {
            message:
              xhr.status === 413
                ? '照片文件：请求超过服务上限，请减少文件大小后重试'
                : `照片文件：服务暂未确认上传结果（${xhr.status}），请稍后重试同一原件`,
          },
          xhr.status,
          `${web}/upload`,
        );
        const hint = /livePhotoVideoId/.test(xhr.responseText)
          ? '；请同时选择同名照片和 MOV 配对原件后重试'
          : '';
        done(
          new UploadError(
            error.message + hint,
            xhr.status,
            xhr.status === 409 || xhr.status === 429 || xhr.status >= 500,
          ),
        );
      } else if (
        !body ||
        typeof body.id !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(body.id) ||
        !['created', 'duplicate'].includes(body.status)
      ) {
        done(new UploadError('照片文件：服务端未返回可确认的保存结果，请重试同一原件'));
      } else done(undefined, body);
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    else xhr.send(form);
  });
}
