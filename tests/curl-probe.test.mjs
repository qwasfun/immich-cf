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
      if (req.url === '/slow-body') {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('part');
        return;
      }
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
    assert.equal(result.metrics.downloadedBytes, Buffer.byteLength('response-private'));
    assert.ok(result.metrics.firstByteSeconds > 0);
    assert.ok(result.metrics.totalSeconds >= result.metrics.firstByteSeconds);
    assert.ok([0, 1, null].includes(result.metrics.proxyUsed));
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
    const stalled = await curlRequest(base + '/slow-body', { method: 'GET', timeoutMs: 200 });
    assert.equal(stalled.metrics.status, 200);
    assert.equal(stalled.metrics.errorCode, 'CURL_28');
    assert.equal(stalled.metrics.downloadedBytes, 4);
    assert.equal(stalled.bytes.toString(), 'part');
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

test('curl 4 MiB 上传、100 Continue、早期413和响应等待超时保留阶段证据', async () => {
  const payload = Buffer.alloc(4 * 1024 * 1024, 173);
  let received = 0;
  const consume = (req, res) => {
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
    });
    req.on('end', () => {
      received = size;
      if (req.method === 'GET' && req.url === '/original') {
        res.end(payload);
        return;
      }
      if (req.url !== '/wait') res.end('ok');
    });
  };
  const server = http.createServer(consume);
  server.on('checkContinue', (req, res) => {
    if (req.url === '/early') {
      res.writeHead(413);
      res.end('too large');
      return;
    }
    res.writeContinue();
    consume(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await curlRequest(base + '/ok', {
      body: payload,
      headers: { Expect: '100-continue' },
    });
    assert.equal(ok.metrics.errorCode, null);
    assert.equal(ok.metrics.status, 200);
    assert.equal(received, payload.length);
    assert.equal(ok.metrics.uploadedBytes, payload.length);
    const original = await curlRequest(base + '/original', {
      method: 'GET',
      maxResponseBytes: payload.length,
    });
    assert.equal(original.metrics.status, 200);
    assert.equal(original.metrics.uploadedBytes, 0);
    assert.equal(original.metrics.downloadedBytes, payload.length);
    assert.deepEqual(original.bytes, payload);
    await assert.rejects(() => curlRequest(base, { method: 'GET', body: payload }), /Invalid/);
    const early = await curlRequest(base + '/early', {
      body: payload,
      headers: { Expect: '100-continue' },
    });
    assert.equal(early.metrics.errorCode, null);
    assert.equal(early.metrics.status, 413);
    assert.equal(early.metrics.uploadedBytes, 0);
    const waiting = await curlRequest(base + '/wait', {
      body: payload,
      headers: { Expect: '' },
      timeoutMs: 500,
    });
    assert.equal(waiting.metrics.errorCode, 'CURL_28');
    assert.equal(waiting.metrics.uploadedBytes, payload.length);
    assert.equal(waiting.metrics.status, 0);
    assert.equal(waiting.metrics.firstByteSeconds, 0);
    // Only the metrics allow-list is serializable evidence, never curl's full JSON or body.
    assert.ok(!JSON.stringify(waiting.metrics).includes('/wait'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
