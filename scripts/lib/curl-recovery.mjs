import { curlRequest } from './curl-request.mjs';
const retryable = (r) =>
  ['CURL_18', 'CURL_28', 'CURL_52', 'CURL_55', 'CURL_56'].includes(r.metrics.errorCode) ||
  (r.metrics.errorCode === 'CURL_35' && r.metrics.uploadedBytes === 0) ||
  (!r.metrics.errorCode && [502, 503, 504].includes(r.metrics.status));
const budget = (value) => {
  if (!Number.isInteger(value) || value < 100 || value > 180000)
    throw new Error('Invalid recovery budget');
  return performance.now() + value;
};
const remaining = (deadline) => Math.max(0, Math.floor(deadline - performance.now()));
export async function retryCurlUpload(
  url,
  { onAttempt = async () => {}, attemptTimeoutMs = 60000, ...options },
) {
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 100 || attemptTimeoutMs > 180000)
    throw new Error('Invalid attempt timeout');
  if (new URL(url).pathname !== '/api/assets' || (options.method && options.method !== 'POST'))
    throw new Error('Recovery only supports asset upload');
  if (
    !Object.entries(options.headers ?? {}).some(
      ([k, v]) =>
        k.toLowerCase() === 'x-immich-checksum' && /^(?:[a-f0-9]{40}|[A-Za-z0-9+/]{27}=)$/i.test(v),
    )
  )
    throw new Error('Upload recovery requires a checksum');
  const body = Buffer.from(options.body),
    headers = { ...options.headers };
  const deadline = budget(options.timeoutMs ?? 120000),
    attempts = [];
  let result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const left = remaining(deadline);
    if (left < 100) break;
    result = await curlRequest(url, {
      ...options,
      headers,
      body,
      timeoutMs: Math.min(attemptTimeoutMs, left),
    });
    const entry = { attempt, ...result.metrics };
    attempts.push(entry);
    await onAttempt(entry);
    if (!retryable(result)) break;
  }
  return result
    ? { ...result, attempts }
    : { metrics: { errorCode: 'TIME_BUDGET', status: null }, bytes: null, attempts };
}
export async function readCurlRanges(
  url,
  {
    expected,
    headers = {},
    tls12 = false,
    proxy,
    timeoutMs = 180000,
    chunkBytes = 512 * 1024,
    onAttempt = async () => {},
  },
) {
  if (
    !Buffer.isBuffer(expected) ||
    !expected.length ||
    expected.length > 8 * 1024 * 1024 ||
    !Number.isInteger(chunkBytes) ||
    chunkBytes < 1 ||
    chunkBytes > 512 * 1024
  )
    throw new Error('Invalid media recovery size');
  if (Object.keys(headers).some((k) => ['range', 'if-range'].includes(k.toLowerCase())))
    throw new Error('Recovery owns range conditions');
  const deadline = budget(timeoutMs),
    started = performance.now(),
    parts = [],
    attempts = [];
  let etag = null;
  const finish = (errorCode, bytes = null) => ({
    metrics: {
      errorCode,
      status: errorCode ? null : 206,
      assembled: !errorCode,
      totalSeconds: (performance.now() - started) / 1000,
      attemptCount: attempts.length,
    },
    bytes,
    attempts,
  });
  for (let offset = 0; offset < expected.length; offset += chunkBytes) {
    const end = Math.min(expected.length - 1, offset + chunkBytes - 1);
    let part = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const left = remaining(deadline);
      if (left < 100) return finish('TIME_BUDGET');
      const result = await curlRequest(url, {
        method: 'GET',
        headers: {
          ...headers,
          Range: `bytes=${offset}-${end}`,
          ...(etag ? { 'If-Range': etag } : {}),
        },
        tls12,
        proxy,
        timeoutMs: Math.min(20000, left),
        maxResponseBytes: chunkBytes,
      });
      const entry = { offset, end, attempt, ...result.metrics };
      attempts.push(entry);
      await onAttempt(entry);
      if (retryable(result)) continue;
      if (result.metrics.errorCode) return finish(result.metrics.errorCode);
      const current = result.responseHeaders.etag;
      if (
        result.metrics.status !== 206 ||
        result.responseHeaders.contentRange !== `bytes ${offset}-${end}/${expected.length}` ||
        !current ||
        !/^"[\x21\x23-\x7e]{1,254}"$/.test(current) ||
        (etag && current !== etag) ||
        result.bytes?.length !== end - offset + 1
      )
        return finish('RANGE_CONTRACT');
      etag = current;
      part = result.bytes;
      break;
    }
    if (!part) return finish('RETRIES_EXHAUSTED');
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  return bytes.equals(expected) ? finish(null, bytes) : finish('CONTENT_MISMATCH');
}
