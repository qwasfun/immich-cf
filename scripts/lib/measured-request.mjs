import http from 'node:http';
import https from 'node:https';
// Timings describe this client only. finish does not prove remote receipt or persistence.
export function measuredRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30000,
    maxResponseBytes = 8 * 1024 * 1024,
  } = {},
) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported protocol');
  const started = performance.now();
  const metrics = {
    elapsedMs: 0,
    connectedMs: null,
    tlsMs: null,
    requestFinishedMs: null,
    responseHeadersMs: null,
    responseBytes: 0,
    status: null,
    errorCode: null,
  };
  return new Promise((resolve) => {
    let settled = false,
      timer;
    const elapsed = () => Math.round(performance.now() - started);
    const finish = (errorCode = null, bytes = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      metrics.elapsedMs = elapsed();
      metrics.errorCode = errorCode;
      resolve({ metrics, bytes });
    };
    const request = (target.protocol === 'https:' ? https : http).request(
      target,
      { method, headers, agent: false },
      (response) => {
        metrics.status = response.statusCode;
        metrics.responseHeadersMs = elapsed();
        const chunks = [];
        response.on('data', (chunk) => {
          metrics.responseBytes += chunk.length;
          if (metrics.responseBytes > maxResponseBytes) {
            finish('RESPONSE_LIMIT');
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => finish(null, Buffer.concat(chunks)));
        response.on('error', () => finish('RESPONSE_ERROR'));
        response.on('aborted', () => finish('RESPONSE_ABORTED'));
      },
    );
    request.on('socket', (socket) => {
      socket.once('connect', () => (metrics.connectedMs = elapsed()));
      socket.once('secureConnect', () => (metrics.tlsMs = elapsed()));
    });
    request.on('finish', () => (metrics.requestFinishedMs = elapsed()));
    request.on('error', (error) =>
      finish(
        ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'].includes(error.code)
          ? error.code
          : 'REQUEST_ERROR',
      ),
    );
    timer = setTimeout(() => {
      finish('TIMEOUT');
      request.destroy();
    }, timeoutMs);
    request.end(body);
  });
}
