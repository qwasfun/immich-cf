import { HttpError } from './http';

// Caller must authenticate the session and verify asset ownership first.
export async function media(
  request: Request,
  bucket: R2Bucket,
  key: string,
  mime: string,
  expectedBytes: number,
) {
  const object = await bucket.head(key);
  if (!object) throw new HttpError(503, '图片暂不可读取，请稍后重试');
  if (object.size !== expectedBytes)
    throw new HttpError(503, '原图大小与记录不符，请保留本机原件并重新上传同一图片');
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Length': String(object.size),
    ETag: object.httpEtag,
    'Accept-Ranges': 'bytes',
  });
  const noneMatch = request.headers.get('If-None-Match');
  if (
    noneMatch &&
    (noneMatch.trim() === '*' ||
      noneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === object.httpEtag))
  ) {
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  // Range applies only to GET. Unsupported/malformed multi-ranges fall back to full 200.
  const value = request.method === 'GET' ? request.headers.get('Range') : null;
  const ifRange = request.headers.get('If-Range');
  const match =
    value && (!ifRange || ifRange === object.httpEtag)
      ? /^bytes=(\d*)-(\d*)$/.exec(value.trim())
      : null;
  let range: { offset: number; length: number } | undefined;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : null;
    const end = match[2] ? Number(match[2]) : null;
    if (
      (start === null || Number.isSafeInteger(start)) &&
      (end === null || Number.isSafeInteger(end))
    ) {
      const offset = start ?? Math.max(0, object.size - end!);
      const last =
        start === null || end === null ? object.size - 1 : Math.min(end, object.size - 1);
      if (offset >= object.size || last < offset) {
        headers.set('Content-Range', `bytes */${object.size}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      range = { offset, length: last - offset + 1 };
      headers.set('Content-Range', `bytes ${offset}-${last}/${object.size}`);
      headers.set('Content-Length', String(range.length));
    }
  }
  if (request.method === 'HEAD') return new Response(null, { headers });
  // Original objects are immutable. Also guard the head/get boundary against replacement.
  const result = await bucket.get(key, {
    ...(range ? { range } : {}),
    onlyIf: { etagMatches: object.etag },
  });
  if (!result || !('body' in result)) throw new HttpError(503, '图片已改变或暂不可读取，请重试');
  return new Response(result.body, { status: range ? 206 : 200, headers });
}
