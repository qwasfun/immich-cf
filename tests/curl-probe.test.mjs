import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { curlRequest } from '../scripts/lib/curl-request.mjs';
test('curl 上传保持字节与凭据隔离，区分413、超时、截断和响应上限', async () => {
  const payload = Buffer.alloc(128 * 1024, 173);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/wait') return;
      if (req.url === '/cut') {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('cut');
        setTimeout(() => res.destroy(), 10);
        return;
      }
      if (req.url === '/ok') {
        assert.deepEqual(Buffer.concat(chunks), payload);
        assert.equal(req.headers.authorization, 'Bearer private-test');
      }
      res.writeHead(req.url === '/reject' ? 413 : 200);
      res.end('response-private');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await curlRequest(base + '/ok', {
      body: payload,
      headers: { Authorization: 'Bearer private-test' },
    });
    assert.equal(result.metrics.errorCode, null);
    assert.equal(result.metrics.status, 200);
    assert.equal(result.metrics.uploadedBytes, payload.length);
    assert.equal(result.bytes.toString(), 'response-private');
    assert.ok(!JSON.stringify(result.metrics).includes('private'));
    assert.equal((await curlRequest(base + '/reject', { body: payload })).metrics.status, 413);
    assert.equal(
      (await curlRequest(base + '/wait', { body: payload, timeoutMs: 200 })).metrics.errorCode,
      'CURL_28',
    );
    assert.equal(
      (await curlRequest(base + '/cut', { body: payload })).metrics.errorCode,
      'CURL_18',
    );
    assert.equal(
      (await curlRequest(base + '/big', { body: payload, maxResponseBytes: 2 })).metrics.errorCode,
      'RESPONSE_LIMIT',
    );
    await assert.rejects(
      () =>
        curlRequest(base, {
          body: payload,
          headers: { Authorization: 'token\r\nurl = elsewhere' },
        }),
      /Invalid/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
