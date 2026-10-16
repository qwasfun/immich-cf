import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { measuredRequest } from '../scripts/lib/measured-request.mjs';
test('上传诊断区分响应、超时、正文中断和大小上限，报告不包含私密字段', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/timeout') return;
      if (req.url === '/abort') {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('short');
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.writeHead(req.url === '/reject' ? 413 : 200);
      res.end('body-secret');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await measuredRequest(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer private-token' },
      body: Buffer.from('upload-secret'),
    });
    assert.equal(ok.metrics.status, 200);
    assert.equal(ok.metrics.errorCode, null);
    assert.ok(ok.metrics.requestFinishedMs !== null);
    assert.ok(ok.metrics.responseHeadersMs !== null);
    assert.equal(ok.bytes.toString(), 'body-secret');
    assert.ok(!JSON.stringify(ok.metrics).includes('secret'));
    assert.ok(!JSON.stringify(ok.metrics).includes('private-token'));
    assert.equal((await measuredRequest(base + '/reject')).metrics.status, 413);
    const timeout = await measuredRequest(base + '/timeout', { timeoutMs: 100 });
    assert.equal(timeout.metrics.errorCode, 'TIMEOUT');
    assert.equal(timeout.metrics.responseHeadersMs, null);
    assert.equal((await measuredRequest(base + '/abort')).metrics.errorCode, 'RESPONSE_ABORTED');
    assert.equal(
      (await measuredRequest(base, { maxResponseBytes: 2 })).metrics.errorCode,
      'RESPONSE_LIMIT',
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
