import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const quote = (value) => {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid curl configuration value');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
};
export async function curlRequest(
  url,
  { method = 'POST', headers = {}, body, timeoutMs = 120000, maxResponseBytes = 65536 } = {},
) {
  if (!['POST', 'GET'].includes(method) || (method === 'GET' && body !== undefined))
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
  const dir = await mkdtemp(join(tmpdir(), 'immich-cf-upload-'));
  const input = join(dir, 'body.bin'),
    output = join(dir, 'response.bin');
  try {
    if (method === 'POST') await writeFile(input, body);
    const config =
      [
        `url = ${quote(url)}`,
        `request = ${quote(method)}`,
        ...headerLines,
        ...(method === 'POST' ? [`data-binary = ${quote('@' + input.replaceAll('\\', '/'))}`] : []),
        `output = ${quote(output.replaceAll('\\', '/'))}`,
        'write-out = "%{json}"',
        `max-time = ${timeoutMs / 1000}`,
        `max-filesize = ${maxResponseBytes}`,
        'silent',
        'show-error',
        'http1.1',
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
      dnsSeconds: raw.time_namelookup ?? null,
      connectSeconds: raw.time_connect ?? null,
      tlsSeconds: raw.time_appconnect ?? null,
      pretransferSeconds: raw.time_pretransfer ?? null,
      uploadedBytes: raw.size_upload ?? null,
      uploadFinishedSeconds: raw.time_posttransfer ?? null,
      firstByteSeconds: raw.time_starttransfer ?? null,
      downloadedBytes: raw.size_download ?? null,
      proxyUsed: raw.proxy_used ?? null,
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
    return { metrics, bytes };
  } finally {
    // Only remove the two files and directory created by this invocation; no recursive deletion.
    await rm(input, { force: true });
    await rm(output, { force: true });
    await rmdir(dir);
  }
}
