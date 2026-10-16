import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { retryCurlUpload, readCurlRanges } from '../scripts/lib/curl-recovery.mjs';
const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
};
test('同内容上传已提交但响应中断后恢复为重复，拒绝不重试且故障有上限', async () => {
  const payload = Buffer.from('fixed test asset'),
    stored = new Map();
  let calls = 0;
  const { server, base } = await listen((req, res) => {
    let chunks = [];
    req.on('data', (b) => chunks.push(b));
    req.on('end', () => {
      calls++;
      assert.deepEqual(Buffer.concat(chunks), payload);
      const key = req.headers['x-immich-checksum'];
      if (!stored.has(key)) stored.set(key, 'one-asset');
      if (calls === 1) {
        res.writeHead(201, { 'Content-Length': '100' });
        res.write('cut');
        setTimeout(() => res.destroy(), 10);
      } else res.end(JSON.stringify({ id: stored.get(key), status: 'duplicate' }));
    });
  });
  try {
    const r = await retryCurlUpload(base + '/api/assets', {
      body: payload,
      headers: { 'x-immich-checksum': 'a'.repeat(40) },
      timeoutMs: 3000,
    });
    assert.equal(r.metrics.errorCode, null);
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0].errorCode, 'CURL_18');
    assert.equal(JSON.parse(r.bytes).id, 'one-asset');
    assert.equal(stored.size, 1);
    await assert.rejects(
      () =>
        retryCurlUpload(base + '/api/auth/login', {
          body: payload,
          headers: { 'x-immich-checksum': 'a'.repeat(40) },
        }),
      /only supports/,
    );
    await assert.rejects(
      () => retryCurlUpload(base + '/api/assets', { body: payload }),
      /requires a checksum/,
    );
  } finally {
    await close(server);
  }
  for (const code of [400, 401, 409, 413, 503]) {
    let count = 0;
    const target = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        count++;
        res.writeHead(code);
        res.end('error');
      });
    });
    try {
      const r = await retryCurlUpload(target.base + '/api/assets', {
        body: payload,
        headers: { 'x-immich-checksum': 'b'.repeat(40) },
        timeoutMs: 3000,
      });
      assert.equal(r.metrics.status, code);
      assert.equal(count, code === 503 ? 3 : 1);
    } finally {
      await close(target.server);
    }
  }
});
test('分段读取在部分响应断开后仅重试该段，携带强ETag且最终字节一致', async () => {
  const expected = Buffer.from('0123456789abcdef'.repeat(4));
  let failed = false;
  const offsets = [];
  const { server, base } = await listen((req, res) => {
    const [, s, e] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    const start = Number(s),
      end = Number(e);
    offsets.push(start);
    if (start > 0) assert.equal(req.headers['if-range'], '"v1"');
    res.writeHead(206, {
      ETag: '"v1"',
      'Content-Range': `bytes ${start}-${end}/${expected.length}`,
      'Content-Length': String(end - start + 1),
    });
    if (start === 16 && !failed) {
      failed = true;
      res.write(expected.subarray(start, start + 2));
      setTimeout(() => res.destroy(), 10);
    } else res.end(expected.subarray(start, end + 1));
  });
  try {
    const r = await readCurlRanges(base + '/image', { expected, chunkBytes: 16, timeoutMs: 3000 });
    assert.equal(r.metrics.errorCode, null);
    assert.deepEqual(r.bytes, expected);
    assert.deepEqual(offsets, [0, 16, 16, 32, 48]);
    assert.equal(r.attempts.filter((x) => x.errorCode === 'CURL_18').length, 1);
  } finally {
    await close(server);
  }
});
test('分段读取拒绝弱或变化ETag、错误范围、忽略Range和等长错误内容', async () => {
  const expected = Buffer.from('0123456789abcdef'.repeat(2));
  for (const mode of ['weak', 'changed', 'range', 'full', 'content']) {
    const { server, base } = await listen((req, res) => {
      const [, s, e] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      const start = Number(s),
        end = Number(e);
      res.writeHead(mode === 'full' ? 200 : 206, {
        ETag: mode === 'weak' ? 'W/"v1"' : mode === 'changed' && start ? '"v2"' : '"v1"',
        'Content-Range':
          mode === 'range' ? 'bytes 1-16/32' : `bytes ${start}-${end}/${expected.length}`,
      });
      res.end(
        mode === 'full'
          ? expected
          : mode === 'content'
            ? Buffer.alloc(end - start + 1)
            : expected.subarray(start, end + 1),
      );
    });
    try {
      const r = await readCurlRanges(base + '/image', {
        expected,
        chunkBytes: 16,
        timeoutMs: 3000,
      });
      assert.notEqual(r.metrics.errorCode, null, mode);
      assert.equal(r.bytes, null, mode);
    } finally {
      await close(server);
    }
  }
});

test('上传接收途中断开后重传完整内容，不保留半个逻辑资产', async () => {
  const payload = Buffer.alloc(4 * 1024 * 1024, 173);
  let interrupted = false,
    partial = 0,
    stored = 0;
  const { server, base } = await listen((req, res) => {
    if (!interrupted) {
      interrupted = true;
      req.once('data', (chunk) => {
        partial = chunk.length;
        req.socket.destroy();
      });
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      assert.deepEqual(Buffer.concat(chunks), payload);
      stored++;
      res.writeHead(201);
      res.end('{"id":"one-asset"}');
    });
  });
  try {
    const result = await retryCurlUpload(base + '/api/assets', {
      body: payload,
      headers: { 'x-immich-checksum': 'c'.repeat(40) },
      timeoutMs: 5000,
    });
    assert.equal(result.metrics.errorCode, null);
    assert.equal(result.metrics.status, 201);
    assert.equal(result.attempts.length, 2);
    assert.ok(['CURL_52', 'CURL_55', 'CURL_56'].includes(result.attempts[0].errorCode));
    assert.ok(partial > 0 && partial < payload.length);
    assert.equal(stored, 1);
  } finally {
    await close(server);
  }
});
