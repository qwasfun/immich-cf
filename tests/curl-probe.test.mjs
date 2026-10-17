import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
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
    assert.equal(result.metrics.tlsPolicy, 'system-default');
    await assert.rejects(
      () => curlRequest(base, { body: payload, tls12: 'true\ninsecure' }),
      /Invalid TLS policy/,
    );
    const explicit = await curlRequest(base + '/ok', {
      body: payload,
      headers: { Authorization: 'Bearer private-test' },
      tls12: true,
    });
    assert.equal(explicit.metrics.errorCode, null);
    assert.equal(explicit.metrics.tlsPolicy, 'TLS1.2-only');
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

test('TLS诊断仍拒绝不可信证书，TLS1.2策略不能连接仅TLS1.3服务', async () => {
  const key = await readFile(new URL('./fixtures/tls/localhost-key.pem', import.meta.url));
  const cert = await readFile(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url));
  for (const version of ['TLSv1.2', 'TLSv1.3']) {
    let handled = 0;
    const server = https.createServer(
      { key, cert, minVersion: version, maxVersion: version },
      (_req, res) => {
        handled++;
        res.end('must not be accepted');
      },
    );
    server.on('tlsClientError', () => {});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await curlRequest(`https://127.0.0.1:${server.address().port}`, {
        method: 'GET',
        tls12: true,
        timeoutMs: 5000,
      });
      assert.equal(result.metrics.errorCode, version === 'TLSv1.2' ? 'CURL_60' : 'CURL_35');
      assert.equal(handled, 0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
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

test('显式本机代理真正承载请求，拒绝私密代理凭据与配置注入', async () => {
  let routed = 0;
  const proxy = http.createServer((req, res) => {
    routed++;
    assert.equal(req.url, 'http://example.invalid/test');
    res.end('proxied');
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const result = await curlRequest('http://example.invalid/test', {
      method: 'GET',
      proxy: `http://127.0.0.1:${proxy.address().port}`,
    });
    assert.equal(result.metrics.errorCode, null);
    assert.equal(result.metrics.proxyUsed, 1);
    assert.equal(result.bytes.toString(), 'proxied');
    assert.equal(routed, 1);
    for (const route of [
      'http://name:private@127.0.0.1:1',
      'http://remote.invalid:1',
      'http://127.0.0.1:1/path',
      'http://127.0.0.1:1\ninsecure',
      'http://[private',
    ]) {
      await assert.rejects(
        () => curlRequest('http://example.invalid/test', { method: 'GET', proxy: route }),
        (error) =>
          error.message === 'Invalid loopback proxy' && !JSON.stringify(error).includes('private'),
      );
    }
  } finally {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
  }
});

test('显式本机直连绕过环境代理，上传重试与Range恢复不经过代理', async () => {
  const { retryCurlUpload, readCurlRanges } = await import('../scripts/lib/curl-recovery.mjs');
  let proxyHits = 0;
  const proxy = http.createServer((req, res) => {
    proxyHits++;
    req.resume();
    res.writeHead(502);
    res.end();
  });
  const origin = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(206, { 'Content-Range': 'bytes 0-2/3', ETag: '"direct"' });
        res.end('abc');
      } else res.end('ok');
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const keys = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
  ];
  const before = keys.map((k) => [k, process.env[k]]);
  try {
    for (const key of keys)
      process.env[key] =
        key.toLowerCase() === 'no_proxy' ? '' : `http://127.0.0.1:${proxy.address().port}`;
    const base = `http://127.0.0.1:${origin.address().port}`;
    const control = await curlRequest(base, { body: Buffer.from('non-private-control') });
    assert.equal(control.metrics.status, 502);
    assert.equal(proxyHits, 1);
    proxyHits = 0;
    const r = await curlRequest(base, { direct: true, body: Buffer.from('private-local') });
    assert.equal(r.metrics.status, 200);
    assert.equal(r.metrics.errorCode, null);
    const up = await retryCurlUpload(base + '/api/assets', {
      direct: true,
      headers: { 'x-immich-checksum': '0'.repeat(40) },
      body: Buffer.from('private-local'),
    });
    assert.equal(up.metrics.status, 200);
    const read = await readCurlRanges(base + '/media', {
      direct: true,
      expected: Buffer.from('abc'),
    });
    assert.equal(read.metrics.errorCode, null);
    assert.deepEqual(read.bytes, Buffer.from('abc'));
    assert.equal(proxyHits, 0);
    await assert.rejects(
      curlRequest(base, {
        direct: true,
        proxy: `http://127.0.0.1:${proxy.address().port}`,
        body: Buffer.from('x'),
      }),
      /Invalid direct\/proxy policy/,
    );
  } finally {
    for (const [key, value] of before)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    origin.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([new Promise((r) => origin.close(r)), new Promise((r) => proxy.close(r))]);
  }
});
