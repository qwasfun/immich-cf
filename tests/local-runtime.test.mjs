import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { getPlatformProxy, unstable_dev } from 'wrangler';

let worker;
let platform;

before(async () => {
  worker = await unstable_dev('src/index.ts', {
    config: 'wrangler.json',
    env: 'dev',
    local: true,
    ip: '127.0.0.1',
    port: 0,
    persist: false,
    vars: { ENABLE_P1_POC: 'false' },
    experimental: { disableExperimentalWarning: true, forceLocal: true, watch: false },
  });
  platform = await getPlatformProxy({
    configPath: 'wrangler.json',
    environment: 'dev',
    persist: false,
    remoteBindings: false,
  });
});

after(async () => {
  try {
    await worker?.stop();
  } finally {
    await platform?.dispose();
  }
});

test('Worker 提供存活检查，不声称已兼容 Immich', async () => {
  const response = await worker.fetch('/healthz');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  assert.deepEqual(await response.json(), {
    service: 'immich-cf',
    status: 'ok',
    version: '0.1.0',
    stage: 'scaffold',
  });
  const head = await worker.fetch('/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('不支持的方法和接口不会返回假成功', async () => {
  const method = await worker.fetch('/healthz', { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, HEAD');
  const api = await worker.fetch('/api/assets', { method: 'POST' });
  assert.equal(api.status, 501);
  assert.equal((await api.json()).code, 'NOT_IMPLEMENTED');
  const missing = await worker.fetch('/missing');
  assert.equal(missing.status, 404);
});

test('本地 D1 能应用初始迁移并回滚失败事务', async () => {
  const db = platform.env.IMMICH_CF_DB;
  const sql = await readFile(
    new URL('../migrations/0001_project_metadata.sql', import.meta.url),
    'utf8',
  );
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  await db.batch(statements.map((statement) => db.prepare(statement)));
  const row = await db
    .prepare('SELECT value FROM project_metadata WHERE key = ?')
    .bind('project_name')
    .first();
  assert.equal(row.value, 'immich-cf');
  await assert.rejects(
    db.batch([
      db
        .prepare('INSERT INTO project_metadata (key, value) VALUES (?, ?)')
        .bind('rollback-test', 'temporary'),
      db
        .prepare('INSERT INTO project_metadata (key, value) VALUES (?, ?)')
        .bind('project_name', 'duplicate'),
    ]),
  );
  assert.equal(
    await db
      .prepare('SELECT value FROM project_metadata WHERE key = ?')
      .bind('rollback-test')
      .first(),
    null,
  );
});

test('本地 R2 绑定可以完整读写并删除二进制对象', async () => {
  const bucket = platform.env.IMMICH_CF_MEDIA;
  const key = 'smoke-test/object';
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  try {
    await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
    const object = await bucket.get(key);
    assert.ok(object);
    assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
  } finally {
    await bucket.delete(key);
  }
  assert.equal(await bucket.get(key), null);
});
