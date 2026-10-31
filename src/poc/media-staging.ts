import { HttpError, invalid } from './http';
import { MAX_MOTION } from './media-format';

const encoder = new TextEncoder();
const limit = MAX_MOTION + 64 * 1024;
function join(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function index(bytes: Uint8Array, needle: Uint8Array, from = 0) {
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
class MultipartStream {
  private buffer = new Uint8Array(0);
  private ended = false;
  private total = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(request: Request) {
    if (!request.body) invalid('assetData', '请选择非空媒体文件');
    this.reader = request.body.getReader();
  }
  async more() {
    if (this.ended) return false;
    let item: ReadableStreamReadResult<Uint8Array>;
    try {
      item = await this.reader.read();
    } catch {
      invalid('assetData', '上传传输中断，请恢复网络后重新上传同一原件');
    }
    if (item.done) {
      this.ended = true;
      return false;
    }
    this.total += item.value.length;
    if (this.total > limit)
      throw new HttpError(
        413,
        'assetData：动态视频最多 64 MiB，照片最多 20,000,000 字节，请选择符合上限的原件',
        'assetData',
      );
    this.buffer = join(this.buffer, item.value);
    return true;
  }
  async take(n: number) {
    while (this.buffer.length < n)
      if (!(await this.more())) invalid('assetData', '上传表单不完整，请重新上传同一原件');
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }
  async until(token: Uint8Array, max: number) {
    while (true) {
      const at = index(this.buffer, token);
      if (at >= 0) {
        if (at > max) invalid('上传分段头', '最多 8 KiB，请减少头字段');
        const out = await this.take(at);
        await this.take(token.length);
        return out;
      }
      if (this.buffer.length > max + token.length)
        invalid('上传分段头', '最多 8 KiB，请减少头字段');
      if (!(await this.more())) invalid('assetData', '上传表单不完整，请重新上传同一原件');
    }
  }
  async *part(delimiter: Uint8Array) {
    while (true) {
      let at = index(this.buffer, delimiter);
      if (at >= 0) {
        while (this.buffer.length < at + delimiter.length + 2)
          if (!(await this.more())) invalid('assetData', '上传表单缺少结束边界，请重新上传');
        const suffix = this.buffer.subarray(at + delimiter.length, at + delimiter.length + 2);
        if ((suffix[0] === 45 && suffix[1] === 45) || (suffix[0] === 13 && suffix[1] === 10)) {
          if (at) yield await this.take(at);
          await this.take(delimiter.length);
          return;
        }
        at += delimiter.length;
        yield await this.take(at);
        continue;
      }
      const count = this.buffer.length - delimiter.length - 2;
      if (count > 0) yield await this.take(count);
      if (!(await this.more())) invalid('assetData', '上传表单或文件不完整，请重新上传同一原件');
    }
  }
  async end() {
    while (await this.more())
      if (this.buffer.length > 2)
        invalid('assetData', '上传结束边界后包含额外内容，请重新生成表单');
    if (
      this.buffer.length &&
      !(this.buffer.length === 2 && this.buffer[0] === 13 && this.buffer[1] === 10)
    )
      invalid('assetData', '上传结束边界无效，请重新生成表单');
  }
  async close() {
    if (!this.ended) await this.reader.cancel().catch(() => undefined);
    this.reader.releaseLock();
  }
}
export interface StagedUpload {
  id: string;
  key: string;
  fields: FormData;
  filename: string;
  size: number;
  hash: string;
  sha1: ArrayBuffer;
}
export async function stageUpload(
  request: Request,
  env: Env,
  owner: string,
): Promise<StagedUpload> {
  const content = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(content))
    throw new HttpError(415, 'Content-Type：请使用 multipart/form-data 上传媒体', 'Content-Type');
  const boundary = /\bboundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(content);
  const value = boundary?.[1] ?? boundary?.[2];
  if (!value || !/^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/.test(value) || value.endsWith(' '))
    invalid('Content-Type', '请提供 1–70 个合法 ASCII 字符的 multipart boundary，末尾不能有空格');
  if (Number(request.headers.get('content-length')) > limit)
    throw new HttpError(413, 'assetData：动态视频最多 64 MiB，请选择符合上限的原件', 'assetData');
  if (!request.body) invalid('assetData', '请选择非空媒体文件');
  const id = crypto.randomUUID(),
    key = `${owner}/staging/${id}`,
    db = env.IMMICH_CF_DB;
  const reserved = await db
    .prepare(
      `INSERT INTO media_upload_staging(id,owner_id,object_key,expires_ms) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM media_upload_staging WHERE owner_id=? AND status='receiving' AND expires_ms>?)<4 AND (SELECT COUNT(*) FROM media_upload_staging WHERE owner_id=? AND status<>'deleted')<8`,
    )
    .bind(id, owner, key, Date.now() + 3600000, owner, Date.now(), owner)
    .run();
  if (!reserved.meta.changes)
    throw new HttpError(
      429,
      'assetData：最多同时接收 4 个文件，或有 8 个暂存任务待清理，请等待上传或暂存恢复后重试',
      'assetData',
    );
  const source = new MultipartStream(request),
    fields = new FormData(),
    seen = new Set<string>(),
    hasher = new crypto.DigestStream('SHA-1'),
    writer = hasher.getWriter();
  hasher.digest.catch(() => undefined);
  let size = 0,
    filename = '',
    files = 0,
    textBytes = 0;
  try {
    const initial = encoder.encode(`--${value}\r\n`);
    if (!(await source.take(initial.length)).every((b, i) => b === initial[i]))
      invalid('assetData', '上传起始边界无效，请重新生成表单');
    const delimiter = encoder.encode(`\r\n--${value}`);
    while (true) {
      if (seen.size >= 32) invalid('上传表单', '最多提交 32 个字段，请减少附加字段');
      let header: string;
      try {
        header = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          await source.until(encoder.encode('\r\n\r\n'), 8192),
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        invalid('上传分段头', '必须使用有效 UTF-8 文本，请重新生成表单');
      }
      const headers = new Map<string, string>();
      for (const line of header.split('\r\n')) {
        const split = line.indexOf(':');
        if (split < 1) invalid('上传分段头', '格式无效，请重新生成表单');
        const name = line.slice(0, split).trim().toLowerCase();
        if (headers.has(name)) invalid('上传分段头', '头字段不得重复，请重新生成表单');
        headers.set(name, line.slice(split + 1).trim());
      }
      const disposition = headers.get('content-disposition') ?? '';
      if (!/^form-data\s*;/i.test(disposition)) invalid('assetData', '上传分段必须使用 form-data');
      const name = /(?:^|;)\s*name="([^"\r\n]*)"/i.exec(disposition)?.[1];
      if (!name || encoder.encode(name).length > 128 || /[\x00-\x1f\x7f]/.test(name))
        invalid('上传字段名', '必须非空、不含控制字符且最多 128 UTF-8 字节');
      if (seen.has(name)) invalid(name, '只能提交一次');
      seen.add(name);
      const file = /(?:^|;)\s*filename="([^"\r\n]*)"/i.exec(disposition);
      const chunks = source.part(delimiter);
      if (file) {
        if (name !== 'assetData' || ++files !== 1)
          invalid(name, '当前只支持一份 assetData 文件，请移除附加文件');
        filename = file[1]!;
        const upload = await env.IMMICH_CF_MEDIA.createMultipartUpload(key),
          parts: R2UploadedPart[] = [];
        try {
          const buffer = new Uint8Array(5 * 1024 * 1024);
          let fill = 0;
          for await (const chunk of chunks) {
            size += chunk.length;
            if (size > MAX_MOTION)
              throw new HttpError(
                413,
                'assetData：动态视频最多 64 MiB，请选择符合上限的原件',
                'assetData',
              );
            await writer.write(chunk);
            let at = 0;
            while (at < chunk.length) {
              const n = Math.min(buffer.length - fill, chunk.length - at);
              buffer.set(chunk.subarray(at, at + n), fill);
              fill += n;
              at += n;
              if (fill === buffer.length) {
                parts.push(await upload.uploadPart(parts.length + 1, buffer));
                fill = 0;
              }
            }
          }
          if (fill) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, fill)));
          if (!parts.length) invalid('assetData', '请选择非空媒体文件');
          await upload.complete(parts);
          await writer.close();
        } catch (error) {
          await upload.abort().catch(() => undefined);
          throw error;
        }
      } else {
        let bytes = new Uint8Array(0);
        for await (const chunk of chunks) {
          if (bytes.length + chunk.length > 8192)
            invalid(name, '最多 8 KiB UTF-8 文本，请缩短此字段');
          bytes = join(bytes, chunk);
        }
        textBytes += bytes.length;
        if (textBytes > 16384)
          invalid('上传文本字段', '合计最多 16 KiB UTF-8 文本，请减少附加字段内容');
        let decoded: string;
        try {
          decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
        } catch {
          invalid(name, '必须使用有效 UTF-8 文本，请重新生成此字段');
        }
        fields.append(name, decoded);
      }
      const suffix = await source.take(2);
      if (suffix[0] === 45 && suffix[1] === 45) {
        await source.end();
        break;
      }
      if (suffix[0] !== 13 || suffix[1] !== 10)
        invalid('assetData', '上传分段边界无效，请重新生成表单');
    }
    if (!files || !size) invalid('assetData', '请选择非空媒体文件');
    const sha1 = await hasher.digest,
      encoded = btoa(String.fromCharCode(...new Uint8Array(sha1)));
    await db
      .prepare(
        "UPDATE media_upload_staging SET status='ready',bytes=?,checksum=? WHERE id=? AND status='receiving'",
      )
      .bind(size, encoded, id)
      .run();
    return { id, key, fields, filename, size, hash: encoded, sha1 };
  } catch (error) {
    console.log(
      JSON.stringify({
        code: 'MEDIA_STAGE_REJECTED',
        status: error instanceof HttpError ? error.status : 503,
      }),
    );
    await db
      .prepare("UPDATE media_upload_staging SET status='complete',expires_ms=? WHERE id=?")
      .bind(Date.now(), id)
      .run()
      .catch(() => undefined);
    await cleanStaging(env, id).catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'assetData：上传暂存结果未确认，请稍后重传同一原件', 'assetData');
  } finally {
    await writer.abort().catch(() => undefined);
    await source.close();
  }
}
// Only this dedicated, never-public staging prefix is eligible. Originals/reservations are untouched.
export async function cleanStaging(env: Env, onlyId?: string) {
  const db = env.IMMICH_CF_DB;
  const rows = await db
    .prepare(
      `SELECT id,owner_id,object_key FROM media_upload_staging WHERE status<>'deleted' AND expires_ms<=? ${onlyId ? 'AND id=?' : ''} LIMIT 3`,
    )
    .bind(Date.now(), ...(onlyId ? [onlyId] : []))
    .all<{ id: string; owner_id: string; object_key: string }>();
  for (const row of rows.results) {
    if (row.object_key !== `${row.owner_id}/staging/${row.id}`) continue;
    const referenced = await db
      .prepare(
        `SELECT 1 WHERE EXISTS(SELECT 1 FROM assets WHERE object_key=? OR integrity_source_key=?) OR EXISTS(SELECT 1 FROM retired_assets WHERE object_key=? OR integrity_source_key=?) OR EXISTS(SELECT 1 FROM upload_intents WHERE object_key=?) OR EXISTS(SELECT 1 FROM integrity_copy_intents WHERE object_key=?) OR EXISTS(SELECT 1 FROM media_previews WHERE object_key=?)`,
      )
      .bind(
        row.object_key,
        row.object_key,
        row.object_key,
        row.object_key,
        row.object_key,
        row.object_key,
        row.object_key,
      )
      .first();
    if (referenced) continue;
    const claim = await db
      .prepare("UPDATE media_upload_staging SET status='deleting' WHERE id=? AND expires_ms<=?")
      .bind(row.id, Date.now())
      .run();
    if (!claim.meta.changes) continue;
    await env.IMMICH_CF_MEDIA.delete(row.object_key);
    await db
      .prepare("UPDATE media_upload_staging SET status='deleted' WHERE id=?")
      .bind(row.id)
      .run();
  }
}
