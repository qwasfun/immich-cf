import {
  getMultipartBoundary,
  MaxHeaderSizeExceededError,
  MaxPartsExceededError,
  MultipartParser,
} from '@remix-run/multipart-parser';
import { HttpError, invalid } from './http';

export const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_REQUEST = MAX_IMAGE + 64 * 1024;

export async function parseUploadForm(request: Request): Promise<FormData> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(type))
    throw new HttpError(415, 'Content-Type：请使用 multipart/form-data 上传图片', 'Content-Type');
  let parser: MultipartParser;
  try {
    const boundary = getMultipartBoundary(type);
    if (!boundary || !/^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/.test(boundary) || boundary.endsWith(' '))
      invalid('Content-Type', '请提供 1–70 个合法 ASCII 字符的 multipart boundary，末尾不能有空格');
    parser = new MultipartParser(boundary, {
      maxHeaderSize: 8192,
      // Preserve complete-form Live Photo checks before the separate 4 MiB file limit.
      maxFileSize: MAX_REQUEST,
      maxTotalSize: MAX_REQUEST,
      maxParts: 1024,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid('Content-Type', 'multipart boundary 无效，请重新生成上传表单');
  }
  if (Number(request.headers.get('content-length')) > MAX_REQUEST)
    throw new HttpError(413, 'assetData：图片最多 4 MiB，请压缩后上传', 'assetData');
  const reader = request.body?.getReader();
  if (!reader) invalid('assetData', '请选择图片文件');
  const form = new FormData();
  const encoder = new TextEncoder();
  let size = 0;
  try {
    while (true) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch {
        invalid('assetData', '上传传输中断，文件未完整接收，请恢复网络后重新上传同一图片');
      }
      if (item.done) break;
      size += item.value.length;
      if (size > MAX_REQUEST)
        throw new HttpError(413, 'assetData：图片最多 4 MiB，请压缩后上传', 'assetData');
      for (const part of parser.write(item.value)) {
        const name = part.name;
        if (!name) invalid('assetData', '上传表单缺少有效字段名，请重新生成表单');
        if (encoder.encode(name).byteLength > 128 || /[\x00-\x1f\x7f]/.test(name))
          invalid('上传字段名', '请使用不含控制字符且最多 128 UTF-8 字节的非空名称');
        if (!/^form-data(?:\s*;|$)/i.test(part.headers['content-disposition'] ?? ''))
          invalid('assetData', '上传分段必须使用 form-data，请重新生成表单');
        const filename = part.filename;
        if (filename !== undefined)
          form.append(name, new File(part.content, filename, { type: part.mediaType ?? '' }));
        else {
          let text: string;
          try {
            text = part.text;
          } catch {
            invalid(name, '必须使用有效 UTF-8 文本，请重新生成此字段');
          }
          form.append(name, text);
        }
      }
    }
    // A part may be yielded before an invalid closing suffix. Never publish before EOF validation.
    parser.finish();
    return form;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      /* Cleanup failure must not replace the original validation or transport error. */
    }
    if (error instanceof HttpError) throw error;
    if (error instanceof MaxHeaderSizeExceededError)
      invalid('上传分段头', '每个分段头合计最多 8 KiB，请减少头字段内容');
    if (error instanceof MaxPartsExceededError)
      invalid('上传表单', '最多提交 32 个字段，请减少附加字段');
    invalid('assetData', '上传表单无效或不完整，请重新选择图片上传');
  } finally {
    reader.releaseLock();
  }
}
