import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { unstable_dev } from 'wrangler';
import { deploySelfhost } from '../scripts/deploy-selfhost.mjs';

const config = JSON.parse(readFileSync('wrangler.json'));
const settings = { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' };
const database = config.d1_databases[0];
const bucket = config.r2_buckets[0];
const cli = path.resolve('node_modules/wrangler/bin/wrangler.js');

test('自部署配置只引用本账号的独立生产资源', () => {
  assert.equal(config.name, 'immich-cf');
  assert.equal(config.account_id, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(database.database_id, undefined);
  assert.equal(config.vars.ENABLE_P1_POC, 'true');
  assert.equal(config.vars.ENABLE_LIVE_PHOTO, 'true');
  assert.equal(config.vars.IMAGES_FREE_CONFIRMED, 'false');
  assert.equal(config.images.binding, 'IMAGES');
  assert.deepEqual(config.triggers.crons, ['*/5 * * * *']);
  for (const env of Object.values(config.env)) {
    assert.ok(env.account_id);
    assert.notEqual(env.name, config.name);
    assert.notEqual(env.d1_databases[0].database_name, database.database_name);
    assert.notEqual(env.r2_buckets[0].bucket_name, bucket.bucket_name);
  }
});

test('只允许 Workers Builds 的 main，D1 权限错误立即停止', async () => {
  const unexpected = () => assert.fail('不应执行 Wrangler');
  await assert.rejects(deploySelfhost({}, unexpected), /main/);
  await assert.rejects(
    deploySelfhost({ ...settings, WORKERS_CI_BRANCH: 'dev' }, unexpected),
    /main/,
  );
  await assert.rejects(
    deploySelfhost(settings, (args) => {
      assert.deepEqual(args, ['d1', 'list', '--json']);
      throw new Error('Authentication error [code: 10000]');
    }),
    /Authentication error/,
  );
});

test('首次发布、迁移失败后重试及改密更新均复用同一图库', async () => {
  const state = mkdtempSync(path.join(tmpdir(), 'immich-selfhost-test-'));
  const commands = [];
  let hasDatabase = false,
    hasBucket = false,
    failMigration = true;
  function run(args) {
    const operation = args.slice(0, 2).join(' ');
    commands.push(operation);
    if (operation === 'd1 list')
      return JSON.stringify(hasDatabase ? [{ name: database.database_name }] : []);
    if (operation === 'd1 create') {
      assert.equal(args[2], database.database_name);
      hasDatabase = true;
      return;
    }
    if (operation === 'r2 bucket') {
      assert.ok(args.includes(bucket.bucket_name));
      if (args[2] === 'create') {
        assert.equal(hasBucket, false);
        hasBucket = true;
        return;
      }
      if (!hasBucket) throw new Error('No such bucket [code: 10006]');
      if (args[2] === 'dev-url') return 'Public access via the r2.dev URL is disabled.';
      assert.equal(args[2], 'domain');
      return 'There are no custom domains connected to this bucket.';
    }
    if (operation === 'deploy') return;
    if (operation === 'd1 migrations' && failMigration) throw new Error('测试迁移失败');
    assert.ok(args.includes('--remote'));
    return execFileSync(
      process.execPath,
      [
        cli,
        ...args.map((arg) => (arg === '--remote' ? '--local' : arg)),
        '--env',
        '',
        '--persist-to',
        state,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
  let worker;
  const start = () =>
    unstable_dev('src/index.ts', {
      config: 'wrangler.json',
      local: true,
      ip: '127.0.0.1',
      port: 0,
      persist: true,
      persistTo: state,
      experimental: { forceLocal: true, watch: false, disableExperimentalWarning: true },
    });
  try {
    await assert.rejects(deploySelfhost(settings, run), /测试迁移失败/);
    assert.ok(!commands.includes('deploy'));
    failMigration = false;
    const email = "o'wner@example.invalid";
    const password = 'selfhost-test-only-password';
    await deploySelfhost(
      { ...settings, INITIAL_ADMIN_EMAIL: email, INITIAL_ADMIN_PASSWORD: password },
      run,
    );
    assert.equal(commands.at(-1), 'deploy');
    worker = await start();
    let origin = 'http://127.0.0.1:' + worker.port;
    const post = (route, body, token) =>
      fetch(origin + route, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify(body),
      });
    const login = async (value) => {
      const response = await post('/api/auth/login', { email, password: value });
      assert.equal(response.status, 201);
      return (await response.json()).accessToken;
    };
    assert.equal((await fetch(origin + '/healthz')).status, 200);
    assert.match(await (await fetch(origin + '/login')).text(), /<html/);
    const token = await login(password);
    assert.equal(
      (
        await post(
          '/api/immich-cf/admin/users',
          { email: 'user@example.invalid', name: '普通用户', password },
          token,
        )
      ).status,
      201,
    );
    const image = readFileSync('tests/fixtures/small.png');
    const form = new FormData();
    form.set('assetData', new File([image], 'test.png', { type: 'image/png' }));
    for (const [name, value] of Object.entries({
      deviceId: 'phone',
      deviceAssetId: 'selfhost-photo',
      fileCreatedAt: '2026-10-14T02:00:00Z',
      fileModifiedAt: '2026-10-14T02:00:00Z',
      duration: '0',
    }))
      form.set(name, value);
    const uploaded = await fetch(origin + '/api/assets', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: form,
    });
    assert.equal(uploaded.status, 201);
    const asset = (await uploaded.json()).id;
    const readOriginal = async (accessToken) => {
      const response = await fetch(origin + '/api/assets/' + asset + '/original', {
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
    };
    await readOriginal(token);
    const next = password + '-changed';
    assert.equal(
      (
        await post(
          '/api/immich-cf/web/password',
          { currentPassword: password, newPassword: next },
          token,
        )
      ).status,
      200,
    );
    await worker.stop();
    worker = undefined;
    await deploySelfhost(settings, run);
    assert.equal(commands.filter((c) => c === 'd1 create').length, 1);
    assert.equal(commands.filter((c) => c === 'deploy').length, 2);
    worker = await start();
    origin = 'http://127.0.0.1:' + worker.port;
    assert.equal((await post('/api/auth/login', { email, password })).status, 401);
    await readOriginal(await login(next));
  } finally {
    await worker?.stop();
    rmSync(state, { recursive: true, force: true });
  }
});
