import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const quote = (value) => {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid curl configuration value');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
};
export function validateLoopbackProxy(proxy) {
  if (typeof proxy !== 'string' || /[\r\n\0]/.test(proxy))
    throw new Error('Invalid loopback proxy');
  let route;
  try {
    route = new URL(proxy);
  } catch {
    throw new Error('Invalid loopback proxy');
  }
  if (
    route.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(route.hostname) ||
    route.username ||
    route.password ||
    route.pathname !== '/' ||
    route.search ||
    route.hash
  )
    throw new Error('Invalid loopback proxy');
  return proxy;
}
export async function curlRequest(
  url,
  {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 120000,
    maxResponseBytes = 65536,
    tls12 = false,
    direct = false,
    proxy,
  } = {},
) {
  if (typeof tls12 !== 'boolean') throw new Error('Invalid TLS policy');
  if (typeof direct !== 'boolean' || (direct && proxy !== undefined))
    throw new Error('Invalid direct/proxy policy');
  if (proxy !== undefined) validateLoopbackProxy(proxy);
  if (
    !['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
    (method === 'GET' && body !== undefined)
  )
    throw new Error('Invalid request method or body');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180000)
    throw new Error('Invalid timeout');
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 8 * 1024 * 1024
  )
    throw new Error('Invalid response limit');
  const target = new URL(url);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password)
    throw new Error('Invalid URL');
  const headerLines = Object.entries(headers).map(([name, value]) => {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error('Invalid header');
    return 'header = ' + quote(`${name}: ${value}`);
  });
  const hasBody = method !== 'GET' && body !== undefined;
  const dir = await mkdtemp(join(tmpdir(), 'immich-cf-upload-'));
  const input = join(dir, 'body.bin'),
    output = join(dir, 'response.bin'),
    responseHead = join(dir, 'headers.txt');
  try {
    if (hasBody) await writeFile(input, body);
    const config =
      [
        `url = ${quote(url)}`,
        `request = ${quote(method)}`,
        ...headerLines,
        ...(hasBody ? [`data-binary = ${quote('@' + input.replaceAll('\\', '/'))}`] : []),
        `output = ${quote(output.replaceAll('\\', '/'))}`,
        `dump-header = ${quote(responseHead.replaceAll('\\', '/'))}`,
        'write-out = "%{json}"',
        `max-time = ${timeoutMs / 1000}`,
        `max-filesize = ${maxResponseBytes}`,
        'silent',
        'show-error',
        'http1.1',
        ...(tls12 ? ['tlsv1.2', 'tls-max = "1.2"'] : []),
        ...(proxy ? [`proxy = ${quote(proxy)}`, 'noproxy = ""'] : []),
        ...(direct ? ['proxy = ""', 'noproxy = "*"'] : []),
        'retry = 0',
      ].join('\n') + '\n';
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.platform === 'win32' ? 'curl.exe' : 'curl',
        ['-q', '--config', '-'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let stdout = '',
        done = false,
        forcedError = null;
      const finish = (exitCode, errorCode = null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ exitCode, errorCode, stdout });
      };
      const timer = setTimeout(() => {
        forcedError = 'PROCESS_TIMEOUT';
        child.kill();
      }, timeoutMs + 5000);
      child.stdout.on('data', (data) => {
        stdout += data;
        if (stdout.length > 65536) {
          forcedError = 'METRICS_LIMIT';
          child.kill();
        }
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.on('error', () => finish(null, 'CURL_UNAVAILABLE'));
      child.on('close', (code) => finish(code, forcedError));
      child.stdin.end(config);
    });
    let raw = {};
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      /* No raw output is exposed. */
    }
    const metrics = {
      exitCode: result.exitCode,
      errorCode:
        result.errorCode ??
        (result.exitCode === 0
          ? null
          : result.exitCode === 63
            ? 'RESPONSE_LIMIT'
            : `CURL_${result.exitCode}`),
      status: raw.http_code ?? null,
      tlsPolicy: tls12 ? 'TLS1.2-only' : 'system-default',
      certificateVerifyResult: raw.ssl_verify_result ?? null,
      dnsSeconds: raw.time_namelookup ?? null,
      connectSeconds: raw.time_connect ?? null,
      tlsSeconds: raw.time_appconnect ?? null,
      pretransferSeconds: raw.time_pretransfer ?? null,
      uploadedBytes: raw.size_upload ?? null,
      uploadFinishedSeconds: raw.time_posttransfer ?? null,
      firstByteSeconds: raw.time_starttransfer ?? null,
      downloadedBytes: raw.size_download ?? null,
      proxyUsed: raw.proxy_used ?? null,
      proxyConnectStatus: raw.http_connect ?? null,
      totalSeconds: raw.time_total ?? null,
      speedUpload: raw.speed_upload ?? null,
    };
    let bytes = null;
    try {
      if ((await stat(output)).size > maxResponseBytes) metrics.errorCode = 'RESPONSE_LIMIT';
      else bytes = await readFile(output);
    } catch {
      if (!metrics.errorCode) metrics.errorCode = 'RESPONSE_MISSING';
    }
    let responseHeaders = { etag: null, contentRange: null };
    try {
      if ((await stat(responseHead)).size > 65536) metrics.errorCode = 'HEADER_LIMIT';
      else {
        const block = (await readFile(responseHead, 'latin1'))
          .split(/\r?\n\r?\n/)
          .filter((x) => /^HTTP\/\S+\s+\d{3}\b/.test(x))
          .at(-1);
        const field = (name) => {
          const values = block
            ?.split(/\r?\n/)
            .filter((x) => x.toLowerCase().startsWith(name + ':'));
          return values?.length === 1 ? values[0].slice(name.length + 1).trim() : null;
        };
        responseHeaders = { etag: field('etag'), contentRange: field('content-range') };
      }
    } catch {
      /* Missing metadata is rejected by range verification when required. */
    }
    return { metrics, bytes, responseHeaders };
  } finally {
    // Only remove the two files and directory created by this invocation; no recursive deletion.
    await rm(input, { force: true });
    await rm(output, { force: true });
    await rm(responseHead, { force: true });
    await rmdir(dir);
  }
}
