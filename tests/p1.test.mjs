import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import { getPlatformProxy, unstable_dev } from 'wrangler';

let worker, platform, db;
const state = path.resolve('work', `p1-test-${crypto.randomUUID()}`);
const password = 'P1-test-only-password-2026';
const userId = crypto.randomUUID();
const spec = JSON.parse(
  await readFile('docs/contracts/upstream/immich-v3.3.1.openapi.json', 'utf8'),
);
const manifest = JSON.parse(await readFile('docs/compatibility-manifest.json', 'utf8'));
const config = {
  config: 'wrangler.json',
  env: 'dev',
  local: true,
  ip: '127.0.0.1',
  port: 0,
  persist: true,
  persistTo: state,
  vars: { ENABLE_P1_POC: 'true' },
  experimental: { disableExperimentalWarning: true, forceLocal: true, watch: false },
};
before(async () => {
  await mkdir(state, { recursive: true });
  const require = createRequire(import.meta.url);
  const cli = path.resolve(path.dirname(require.resolve('wrangler')), '../bin/wrangler.js');
  // Exercise the release SQL parser too: hand-splitting SQL hid a CASE/END migration failure.
  execFileSync(
    process.execPath,
    [
      cli,
      'd1',
      'migrations',
      'apply',
      'IMMICH_CF_DB',
      '--env',
      'dev',
      '--local',
      '--persist-to',
      state,
    ],
    { stdio: 'pipe' },
  );
  platform = await getPlatformProxy({
    configPath: 'wrangler.json',
    environment: 'dev',
    persist: { path: path.join(state, 'v3') },
    remoteBindings: false,
  });
  db = platform.env.IMMICH_CF_DB;
  await db
    .prepare(
      'INSERT INTO users (id,email,name,password_hash,created_at,update_id) VALUES (?,?,?,?,?,?)',
    )
    .bind(
      userId,
      'p1@example.invalid',
      'P1 测试',
      await bcrypt.hash(password, 12),
      '2026-10-13T00:00:00.000Z',
      '019e0000-0000-7000-8000-000000000001',
    )
    .run();
  worker = await unstable_dev('tests/fixtures/fault-worker.ts', config);
});
after(async () => {
  try {
    await worker?.stop();
  } finally {
    await platform?.dispose();
  }
});

const send = (url, data, token, method = 'POST') =>
  worker.fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });
async function login() {
  const r = await send('/api/auth/login', { email: 'p1@example.invalid', password });
  assert.equal(r.status, 201);
  const data = await r.json();
  schema(data, 'LoginResponseDto');
  return { token: data.accessToken, headers: r.headers };
}
function schema(value, name) {
  const check = (v, s) => {
    if (s.$ref) return check(v, spec.components.schemas[s.$ref.split('/').at(-1)]);
    if (v === null && s.nullable) return;
    if (s.allOf) for (const child of s.allOf) check(v, child);
    if (s.enum) assert.ok(s.enum.includes(v), `enum ${JSON.stringify(v)}`);
    if (s.type === 'object') {
      assert.ok(v && typeof v === 'object' && !Array.isArray(v));
      for (const key of s.required ?? []) assert.ok(Object.hasOwn(v, key), `${name}.${key} 缺失`);
      for (const [key, child] of Object.entries(s.properties ?? {}))
        if (Object.hasOwn(v, key)) check(v[key], child);
    }
    if (s.type === 'string') assert.equal(typeof v, 'string');
    if (s.type === 'boolean') assert.equal(typeof v, 'boolean');
    if (s.type === 'integer') assert.ok(Number.isInteger(v));
    if (s.type === 'array') {
      assert.ok(Array.isArray(v));
      for (const item of v) check(item, s.items);
    }
  };
  check(value, spec.components.schemas[name]);
}

test('发现、版本、能力和配置符合冻结 schema，非目标写入明确失败', async () => {
  assert.deepEqual(await (await worker.fetch('/.well-known/immich')).json(), {
    api: { endpoint: '/api' },
  });
  for (const [endpoint, name] of [
    ['version', 'ServerVersionResponseDto'],
    ['features', 'ServerFeaturesDto'],
    ['config', 'ServerConfigDto'],
  ]) {
    const r = await worker.fetch(`/api/server/${endpoint}`);
    assert.equal(r.status, 200);
    schema(await r.json(), name);
  }
  assert.equal((await send('/api/assets', {})).status, 401);
  assert.equal((await send('/api/server/ping', {})).status, 405);
});

test('字段校验具体且不泄露提交值；错误凭据一致', async () => {
  const r = await send('/api/auth/login', { email: 'private-invalid', password: '' });
  assert.equal(r.status, 400);
  const raw = await r.text();
  assert.match(raw, /email/);
  assert.ok(!raw.includes('private-invalid'));
  const wrong = await send('/api/auth/login', { email: 'p1@example.invalid', password: 'wrong' });
  const absent = await send('/api/auth/login', {
    email: 'absent@example.invalid',
    password: 'wrong',
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), await absent.json());
  assert.equal(
    (await send('/api/auth/login', { email: 'p1@example.invalid', password: '中'.repeat(25) }))
      .status,
    400,
  );
  assert.equal((await send('/api/auth/login', { padding: 'x'.repeat(70000) })).status, 413);
});

test('Cookie/Bearer、持久化、会话隔离、撤销和过期', async () => {
  await db.prepare('DELETE FROM login_buckets').run();
  const a = await login(),
    b = await login();
  assert.match(a.headers.get('set-cookie'), /HttpOnly/);
  const me = await worker.fetch('/api/users/me', {
    headers: { Cookie: `immich_access_token=${a.token}` },
  });
  assert.equal(me.status, 200);
  schema(await me.json(), 'UserAdminResponseDto');
  const stored = await db.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(stored.results.every((r) => r.token_hash !== a.token && r.token_hash !== b.token));
  await worker.stop();
  worker = await unstable_dev('tests/fixtures/fault-worker.ts', config);
  assert.equal(
    (await worker.fetch('/api/users/me', { headers: { Authorization: `Bearer ${a.token}` } }))
      .status,
    200,
  );
  assert.equal(
    (
      await worker.fetch('/api/users/me', {
        headers: { Authorization: `Bearer ${b.token}`, Cookie: `immich_access_token=${a.token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: `immich_access_token=${a.token}`, Origin: 'https://evil.invalid' },
      })
    ).status,
    403,
  );
  const logout = await send('/api/auth/logout', {}, a.token);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(
    (await worker.fetch('/api/users/me', { headers: { Cookie: `immich_access_token=${a.token}` } }))
      .status,
    401,
  );
  assert.equal(
    (await worker.fetch('/api/users/me', { headers: { Authorization: `Bearer ${b.token}` } }))
      .status,
    200,
  );
  await db.prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal(
    (await worker.fetch('/api/users/me', { headers: { Authorization: `Bearer ${b.token}` } }))
      .status,
    401,
  );
});

test('22 家族空库同步、ACK 重放与隔离、reset 闭环', async () => {
  await db.prepare('DELETE FROM login_buckets').run();
  const a = await login(),
    b = await login();
  const stream = async (token, extra = {}) => {
    const r = await send(
      '/api/sync/stream',
      { types: manifest.sync.requestedTypes, ...extra },
      token,
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/jsonlines+json');
    const text = await r.text();
    assert.ok(text.endsWith('\n'));
    return text.trimEnd().split('\n').map(JSON.parse);
  };
  const initial = await stream(a.token);
  assert.deepEqual(
    initial.map((x) => x.type),
    ['AuthUserV2', 'UserV1', 'SyncCompleteV1'],
  );
  schema(initial[0].data, 'SyncAuthUserV2');
  const acks = initial.map((x) => x.ack);
  assert.equal((await send('/api/sync/ack', { acks }, b.token)).status, 400);
  assert.equal((await send('/api/sync/ack', { acks }, a.token)).status, 204);
  assert.equal((await send('/api/sync/ack', { acks }, a.token)).status, 204);
  assert.deepEqual(
    (await stream(a.token)).map((x) => x.type),
    ['SyncCompleteV1'],
  );
  assert.equal((await stream(b.token))[0].type, 'AuthUserV2');
  const reset = (await stream(a.token, { reset: true }))[0];
  assert.equal(reset.type, 'SyncResetV1');
  assert.equal((await send('/api/sync/ack', { acks: [reset.ack] }, a.token)).status, 204);
  assert.equal((await stream(a.token))[0].type, 'AuthUserV2');
  assert.equal(
    (await send('/api/sync/ack', { types: ['AssetV1'] }, a.token, 'DELETE')).status,
    204,
  );
  assert.equal((await send('/api/sync/stream', { types: ['unsupported'] }, a.token)).status, 400);
});

test('登录限流在昂贵密码校验之前生效', async () => {
  await db.prepare('DELETE FROM login_buckets').run();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await send('/api/auth/login', { email: 'limited@example.invalid', password: 'wrong' }))
        .status,
      401,
    );
  const r = await send('/api/auth/login', { email: 'limited@example.invalid', password: 'wrong' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
});

test('App 并行用户刷新所需偏好读取，默认值符合冻结契约且写入不伪成功', async () => {
  await db.prepare('DELETE FROM login_buckets').run();
  assert.equal((await worker.fetch('/api/users/me/preferences')).status, 401);
  const { token } = await login();
  const headers = { Authorization: `Bearer ${token}` };
  const [me, prefs] = await Promise.all([
    worker.fetch('/api/users/me', { headers }),
    worker.fetch('/api/users/me/preferences', { headers }),
  ]);
  assert.equal(me.status, 200);
  assert.equal(prefs.status, 200);
  const value = await prefs.json();
  schema(value, 'UserPreferencesResponseDto');
  assert.equal(value.download.archiveSize, 4294967296);
  assert.equal(value.people.minimumFaces, 3);
  assert.equal(value.albums.defaultAssetOrder, 'desc');
  assert.equal(prefs.headers.get('cache-control'), 'no-store');
  assert.equal(
    (await send('/api/users/me/preferences', { memories: { enabled: false } }, token, 'PUT'))
      .status,
    501,
  );
  assert.deepEqual(
    await (await worker.fetch('/api/users/me/preferences', { headers })).json(),
    value,
  );
});

test('会话列表无秘密、隔离用户、批量撤销保留当前会话并清理同步状态', async () => {
  await db.prepare('DELETE FROM login_buckets').run();
  const a = await login(),
    b = await login();
  const get = (token) =>
    worker.fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await worker.fetch('/api/sessions')).status, 401);
  const rows = await (await get(a.token)).json();
  for (const row of rows) schema(row, 'SessionResponseDto');
  assert.equal(rows.filter((row) => row.current).length, 1);
  assert.ok(rows.every((row) => !('token' in row) && !('token_hash' in row)));
  const bId = (await (await get(b.token)).json()).find((row) => row.current).id;
  await send('/api/sync/stream', { types: ['AuthUsersV2'] }, b.token);
  const foreignUser = crypto.randomUUID(),
    foreignSession = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO users SELECT ?, ?, name, password_hash, created_at, update_id, disabled FROM users WHERE id = ?',
    )
    .bind(foreignUser, 'other@example.invalid', userId)
    .run();
  await db
    .prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
    .bind(foreignSession, foreignUser, 'foreign-hash', Date.now() + 86400000)
    .run();
  assert.ok(!(await (await get(a.token)).json()).some((row) => row.id === foreignSession));
  assert.equal((await send(`/api/sessions/${foreignSession}`, {}, a.token, 'DELETE')).status, 400);
  const invalidId = await send('/api/sessions/not-a-uuid', {}, a.token, 'DELETE');
  assert.equal(invalidId.status, 400);
  assert.deepEqual((await invalidId.json()).errors[0].path, ['id']);
  assert.equal(
    (
      await worker.fetch('/api/sessions', {
        method: 'DELETE',
        headers: { Cookie: `immich_access_token=${a.token}`, Origin: 'https://evil.invalid' },
      })
    ).status,
    403,
  );
  assert.equal((await send('/api/sessions', {}, a.token, 'DELETE')).status, 204);
  assert.equal((await get(b.token)).status, 401);
  assert.equal((await get(a.token)).status, 200);
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) AS n FROM sync_deliveries WHERE session_id = ?')
        .bind(bId)
        .first()
    ).n,
    0,
  );
  assert.ok(await db.prepare('SELECT id FROM sessions WHERE id = ?').bind(foreignSession).first());
  const aId = (await (await get(a.token)).json()).find((row) => row.current).id;
  assert.equal((await send(`/api/sessions/${aId}`, {}, a.token, 'DELETE')).status, 204);
  assert.equal((await get(a.token)).status, 401);
});

test('初始化 onboarding 持久化、字段校验、隔离、Sync 增量与删除重建', async () => {
  await db.prepare('DELETE FROM login_buckets').run();
  const { token } = await login();
  const headers = { Authorization: `Bearer ${token}` };
  const get = () => worker.fetch('/api/users/me/onboarding', { headers });
  const stream = async () => {
    const r = await send('/api/sync/stream', { types: ['UserMetadataV1'] }, token);
    assert.equal(r.status, 200);
    return (await r.text()).trim().split('\n').map(JSON.parse);
  };
  const ack = async (events) =>
    assert.equal(
      (await send('/api/sync/ack', { acks: events.map((e) => e.ack) }, token)).status,
      204,
    );
  assert.equal((await worker.fetch('/api/users/me/onboarding')).status, 401);
  assert.deepEqual(await (await get()).json(), { isOnboarded: false });
  for (const value of [null, 'private-input', 1]) {
    const r = await send('/api/users/me/onboarding', { isOnboarded: value }, token, 'PUT');
    assert.equal(r.status, 400);
    const error = await r.json();
    assert.deepEqual(error.errors[0].path, ['isOnboarded']);
    assert.ok(!JSON.stringify(error).includes('private-input'));
  }
  const save = await send('/api/users/me/onboarding', { isOnboarded: true }, token, 'PUT');
  assert.equal(save.status, 200);
  schema(await save.json(), 'OnboardingResponseDto');
  await worker.stop();
  worker = await unstable_dev('tests/fixtures/fault-worker.ts', config);
  assert.deepEqual(await (await get()).json(), { isOnboarded: true });
  const initial = await stream();
  assert.equal(initial[0].type, 'UserMetadataV1');
  schema(initial[0].data, 'SyncUserMetadataV1');
  assert.equal(initial[0].data.value.isOnboarded, true);
  await ack(initial);
  assert.deepEqual(
    (await stream()).map((e) => e.type),
    ['SyncCompleteV1'],
  );
  assert.equal((await send('/api/users/me/onboarding', {}, token, 'DELETE')).status, 204);
  const deleted = await stream();
  assert.equal(deleted[0].type, 'UserMetadataDeleteV1');
  schema(deleted[0].data, 'SyncUserMetadataDeleteV1');
  await ack(deleted);
  await ack(initial); // replay of an old value ACK must not resurrect it
  assert.deepEqual(
    (await stream()).map((e) => e.type),
    ['SyncCompleteV1'],
  );
  assert.deepEqual(await (await get()).json(), { isOnboarded: false });
  await Promise.all(
    [true, false, true].map((isOnboarded) =>
      send('/api/users/me/onboarding', { isOnboarded }, token, 'PUT'),
    ),
  );
  assert.equal(
    (
      await db
        .prepare('SELECT revision FROM user_onboarding WHERE user_id = ?')
        .bind(userId)
        .first()
    ).revision,
    5,
  );
  const recreated = await stream();
  assert.equal(recreated[0].type, 'UserMetadataV1');
  assert.ok(recreated[0].ack.split('|')[1] > deleted[0].ack.split('|')[1]);
  await ack(recreated);
  const otherUser = crypto.randomUUID(),
    otherSession = crypto.randomUUID(),
    otherToken = 'e'.repeat(64);
  const { createHash } = await import('node:crypto');
  await db
    .prepare(
      'INSERT INTO users SELECT ?, ?, name, password_hash, created_at, update_id, disabled FROM users WHERE id = ?',
    )
    .bind(otherUser, 'onboarding-other@example.invalid', userId)
    .run();
  await db
    .prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
    .bind(
      otherSession,
      otherUser,
      createHash('sha256').update(otherToken).digest('hex'),
      Date.now() + 86400000,
    )
    .run();
  assert.deepEqual(
    await (
      await worker.fetch('/api/users/me/onboarding', {
        headers: { Authorization: `Bearer ${otherToken}` },
      })
    ).json(),
    { isOnboarded: false },
  );
  const otherStream = await send('/api/sync/stream', { types: ['UserMetadataV1'] }, otherToken);
  assert.deepEqual(
    (await otherStream.text())
      .trim()
      .split('\n')
      .map(JSON.parse)
      .map((e) => e.type),
    ['SyncCompleteV1'],
  );
  const media = await worker.fetch('/api/server/media-types');
  assert.equal(media.status, 200);
  const types = await media.json();
  schema(types, 'ServerMediaTypesResponseDto');
  assert.deepEqual(types, { image: ['image/jpeg', 'image/png'], video: [], sidecar: [] });
});

test('小图片上传、重复检测、Sync 资产、详情与私有媒体读取闭环', async () => {
  await db.prepare('DELETE FROM login_buckets').run();
  const { token } = await login();
  const headers = { Authorization: `Bearer ${token}` };
  const png = await readFile('tests/fixtures/small.png');
  const jpg = await readFile('tests/fixtures/small.jpg');
  const upload = async (
    bytes,
    extra = {},
    mime = 'application/octet-stream',
    uploadHeaders = headers,
  ) => {
    const form = new FormData();
    form.set('assetData', new File([bytes], 'small.png', { type: mime }));
    form.set('fileCreatedAt', '2026-10-14T02:00:00+08:00');
    form.set('fileModifiedAt', '2026-10-14T02:00:00+08:00');
    form.set('deviceAssetId', 'ios-test-id');
    form.set('deviceId', 'ios-test-device');
    form.set('duration', '0');
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    const encoded = new Request('http://localhost/api/assets', {
      method: 'POST',
      headers: uploadHeaders,
      body: form,
    });
    return worker.fetch('/api/assets', {
      method: 'POST',
      headers: Object.fromEntries(encoded.headers),
      body: await encoded.arrayBuffer(),
    });
  };
  assert.equal((await upload(png, {}, '', {})).status, 401);
  assert.equal((await upload(Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await upload(Buffer.from('<svg></svg>'))).status, 400);
  assert.equal((await upload(png, { fileCreatedAt: 'invalid-secret' })).status, 400);
  assert.equal((await upload(png, { visibility: 'hidden' })).status, 400);
  assert.equal((await upload(png, { sidecarData: 'not-supported' })).status, 400);
  assert.equal(
    (await upload(png, {}, '', { ...headers, 'x-immich-checksum': '0'.repeat(40) })).status,
    400,
  );
  const meta = JSON.stringify([{ key: 'mobile-app', value: { cloudId: 'fixture-only' } }]);
  const first = await upload(png, { metadata: meta });
  assert.equal(first.status, 201);
  const saved = await first.json();
  schema(saved, 'AssetMediaResponseDto');
  assert.equal(saved.status, 'created');
  const duplicate = await upload(png, { metadata: meta });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { id: saved.id, status: 'duplicate' });
  const concurrent = await Promise.all([upload(jpg), upload(jpg)]);
  assert.deepEqual(concurrent.map((x) => x.status).sort(), [200, 201]);
  const ids = await Promise.all(concurrent.map((x) => x.json()));
  assert.equal(ids[0].id, ids[1].id);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM assets WHERE owner_id=?').bind(userId).first()).n,
    2,
  );
  const info = await worker.fetch(`/api/assets/${saved.id}`, { headers });
  assert.equal(info.status, 200);
  const detail = await info.json();
  schema(detail, 'AssetResponseDto');
  assert.equal(detail.width, 320);
  const check = await send(
    '/api/assets/bulk-upload-check',
    { assets: [{ id: 'local-fixture', checksum: detail.checksum }] },
    token,
  );
  schema(await check.clone().json(), 'AssetBulkUploadCheckResponseDto');
  assert.equal((await check.json()).results[0].assetId, saved.id);
  for (const suffix of [
    'original',
    'thumbnail?size=thumbnail',
    'thumbnail?size=preview&edited=true',
    'thumbnail?size=fullsize',
  ]) {
    const media = await worker.fetch(`/api/assets/${saved.id}/${suffix}`, { headers });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
    assert.equal((await worker.fetch(`/api/assets/${saved.id}/${suffix}`)).status, 401);
  }
  const otherToken = 'e'.repeat(64); // other user created by onboarding isolation test
  assert.equal(
    (
      await worker.fetch(`/api/assets/${saved.id}/original`, {
        headers: { Authorization: `Bearer ${otherToken}` },
      })
    ).status,
    404,
  );
  const stream = async () => {
    const response = await send(
      '/api/sync/stream',
      { types: ['AssetsV2', 'AssetMetadataV1'] },
      token,
    );
    assert.equal(response.status, 200);
    return (await response.text()).trim().split('\n').map(JSON.parse);
  };
  const events = await stream();
  const assets = events.filter((x) => x.type === 'AssetV2');
  assert.equal(assets.length, 2);
  for (const event of assets) schema(event.data, 'SyncAssetV2');
  const metadata = events.find((x) => x.type === 'AssetMetadataV1');
  schema(metadata.data, 'SyncAssetMetadataV1');
  assert.equal(metadata.data.value.cloudId, 'fixture-only');
  assert.equal(
    (await send('/api/sync/ack', { acks: events.map((x) => x.ack) }, token)).status,
    204,
  );
  assert.deepEqual(
    (await stream()).map((x) => x.type),
    ['SyncCompleteV1'],
  );
  await send('/api/sync/ack', { types: ['AssetV2', 'AssetMetadataV1'] }, token, 'DELETE');
  assert.equal((await stream()).filter((x) => x.type === 'AssetV2').length, 2);
  await worker.stop();
  worker = await unstable_dev('tests/fixtures/fault-worker.ts', config);
  assert.deepEqual(
    Buffer.from(
      await (await worker.fetch(`/api/assets/${saved.id}/original`, { headers })).arrayBuffer(),
    ),
    png,
  );
});

test('官方客户端资产 owner 外键：AuthUser 已确认的旧会话补发 UserV1 后重试资产', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const client = new DatabaseSync(':memory:');
  client.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE auth_user_entity (id TEXT PRIMARY KEY);
    CREATE TABLE user_entity (id TEXT PRIMARY KEY);
    CREATE TABLE remote_asset_entity (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES user_entity(id));`);
  try {
    await db.prepare('DELETE FROM login_buckets').run();
    const { token } = await login();
    const stream = async (types) => {
      const r = await send('/api/sync/stream', { types }, token);
      assert.equal(r.status, 200);
      return (await r.text()).trim().split('\n').map(JSON.parse);
    };
    const auth = await stream(['AuthUsersV2']);
    client.prepare('INSERT INTO auth_user_entity VALUES (?)').run(auth[0].data.id);
    await send('/api/sync/ack', { acks: auth.map((x) => x.ack) }, token);
    const events = await stream(manifest.sync.requestedTypes);
    const owner = events.find((x) => x.type === 'UserV1');
    assert.ok(owner);
    schema(owner.data, 'SyncUserV1');
    assert.equal(owner.data.id, userId);
    assert.ok(!events.some((x) => x.type === 'AuthUserV2'));
    const asset = events.find((x) => x.type === 'AssetV2');
    assert.ok(asset);
    // Reproduce the old stream failure even though AuthUserV2 was applied successfully.
    assert.throws(
      () =>
        client
          .prepare('INSERT INTO remote_asset_entity VALUES (?,?)')
          .run(asset.data.id, asset.data.ownerId),
      /FOREIGN KEY/,
    );
    assert.ok(events.indexOf(owner) < events.indexOf(asset));
    for (const event of events) {
      if (event.type === 'UserV1')
        client.prepare('INSERT INTO user_entity VALUES (?)').run(event.data.id);
      if (event.type === 'AssetV2')
        client
          .prepare('INSERT INTO remote_asset_entity VALUES (?,?)')
          .run(event.data.id, event.data.ownerId);
    }
    assert.equal(client.prepare('SELECT COUNT(*) AS n FROM remote_asset_entity').get().n, 2);
    assert.equal(
      (await send('/api/sync/ack', { acks: events.map((x) => x.ack) }, token)).status,
      204,
    );
    assert.deepEqual(
      (await stream(manifest.sync.requestedTypes)).map((x) => x.type),
      ['SyncCompleteV1'],
    );
    const reset = await streamReset(token);
    await send('/api/sync/ack', { acks: [reset.ack] }, token);
    const rebuilt = await stream(manifest.sync.requestedTypes);
    assert.ok(
      rebuilt.findIndex((x) => x.type === 'UserV1') <
        rebuilt.findIndex((x) => x.type === 'AssetV2'),
    );
  } finally {
    client.close();
  }
});

async function reliabilityAccount() {
  const { createHash } = await import('node:crypto');
  const id = crypto.randomUUID(),
    token = crypto.randomUUID().replaceAll('-', '').repeat(2);
  await db
    .prepare(
      'INSERT INTO users SELECT ?, ?, name, password_hash, created_at, update_id, disabled FROM users WHERE id=?',
    )
    .bind(id, `${id}@example.invalid`, userId)
    .run();
  await db
    .prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
    .bind(
      crypto.randomUUID(),
      id,
      createHash('sha256').update(token).digest('hex'),
      Date.now() + 86400000,
    )
    .run();
  return { id, token };
}
async function uploadFixture(token, file = 'small.png', fault = '') {
  const form = new FormData();
  form.set('assetData', new File([await readFile(`tests/fixtures/${file}`)], `恢复测试-${file}`));
  form.set('fileCreatedAt', '2026-10-14T00:00:00Z');
  form.set('fileModifiedAt', '2026-10-14T00:00:00Z');
  const encoded = new Request('http://localhost/api/assets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-test-storage-fault': fault },
    body: form,
  });
  return worker.fetch('/api/assets', {
    method: 'POST',
    headers: Object.fromEntries(encoded.headers),
    body: await encoded.arrayBuffer(),
  });
}

test('上传 D1 事务失败可恢复：保留意图、重启复用 R2、响应丢失和并发只生成一个资产', async () => {
  const { id, token } = await reliabilityAccount();
  // Fail the second statement: asset insertion must roll back with intent deletion.
  await db
    .prepare(
      `CREATE TRIGGER test_upload_failure BEFORE DELETE ON upload_intents
    WHEN OLD.owner_id = '${id}' BEGIN SELECT RAISE(ABORT, 'TEST_D1_FAILURE'); END`,
    )
    .run();
  try {
    for (let n = 0; n < 2; n++) {
      const failure = await uploadFixture(token);
      assert.equal(failure.status, 503);
      assert.deepEqual((await failure.json()).errors[0].path, ['assetData']);
    }
    assert.equal(
      (await db.prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=?').bind(id).first()).n,
      0,
    );
    const intents = (
      await db.prepare('SELECT * FROM upload_intents WHERE owner_id=?').bind(id).all()
    ).results;
    assert.equal(intents.length, 1);
    const objects = await platform.env.IMMICH_CF_MEDIA.list({ prefix: `${id}/` });
    assert.deepEqual(
      objects.objects.map((x) => x.key),
      [intents[0].object_key],
    );
    await worker.stop();
    worker = await unstable_dev('tests/fixtures/fault-worker.ts', config);
  } finally {
    await db.prepare('DROP TRIGGER test_upload_failure').run();
  }
  const pending = await db
    .prepare('SELECT id,object_key FROM upload_intents WHERE owner_id=?')
    .bind(id)
    .first();
  const recovered = await uploadFixture(token);
  assert.equal(recovered.status, 201);
  const saved = await recovered.json();
  assert.equal(saved.id, pending.id);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM upload_intents WHERE owner_id=?').bind(id).first()).n,
    0,
  );
  // Simulate a caller losing the successful response, then repeating the entire upload.
  assert.deepEqual(await (await uploadFixture(token)).json(), {
    id: saved.id,
    status: 'duplicate',
  });
  const raced = await Promise.all([1, 2, 3].map(() => uploadFixture(token, 'small.jpg')));
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 200, 201]);
  const bodies = await Promise.all(raced.map((r) => r.json()));
  assert.equal(new Set(bodies.map((x) => x.id)).size, 1);
  assert.equal((await platform.env.IMMICH_CF_MEDIA.list({ prefix: `${id}/` })).objects.length, 2);
  // An existing D1 row must not silently report duplicate when its object is missing.
  await platform.env.IMMICH_CF_MEDIA.delete(pending.object_key);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await worker.fetch(`/api/assets/${saved.id}/original`, { headers })).status, 503);
  assert.equal((await uploadFixture(token)).status, 200);
  const restored = await worker.fetch(`/api/assets/${saved.id}/original`, { headers });
  assert.equal(restored.status, 200);
  assert.deepEqual(
    Buffer.from(await restored.arrayBuffer()),
    await readFile('tests/fixtures/small.png'),
  );
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=?').bind(id).first()).n,
    2,
  );
});

test('未完成上传占用容量，超限拒绝在 R2 写入之前；已有预约仍可恢复', async () => {
  const { id, token } = await reliabilityAccount();
  const { createHash } = await import('node:crypto');
  const pngHash = createHash('sha1')
    .update(await readFile('tests/fixtures/small.png'))
    .digest('base64');
  for (let i = 0; i < 20; i++) {
    const asset = crypto.randomUUID();
    await db
      .prepare('INSERT INTO upload_intents VALUES (?,?,?,?,?)')
      .bind(
        id,
        i === 0 ? pngHash : `pending-${i}`,
        asset,
        `${id}/${asset}/original`,
        new Date().toISOString(),
      )
      .run();
  }
  const denied = await uploadFixture(token, 'small.jpg');
  assert.equal(denied.status, 409);
  assert.deepEqual((await denied.json()).errors[0].path, ['assetData']);
  assert.equal((await platform.env.IMMICH_CF_MEDIA.list({ prefix: `${id}/` })).objects.length, 0);
  assert.equal((await uploadFixture(token)).status, 201);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM upload_intents WHERE owner_id=?').bind(id).first()).n,
    19,
  );
});

test('非空 Sync 未确认重拉、部分 ACK、混合非法 ACK 原子拒绝、乱序重放不回退', async () => {
  await db.prepare('DELETE FROM login_buckets').run();
  const { token } = await login();
  const stream = async () => {
    const r = await send('/api/sync/stream', { types: manifest.sync.requestedTypes }, token);
    assert.equal(r.status, 200);
    return (await r.text()).trim().split('\n').map(JSON.parse);
  };
  const interrupted = await send(
    '/api/sync/stream',
    { types: manifest.sync.requestedTypes },
    token,
  );
  const reader = interrupted.body.getReader();
  await reader.read();
  await reader.cancel(); // Client stops consuming without committing any ACK.
  const first = await stream();
  // No ACK after an interrupted/failed client application: same asset events replay.
  const assets = (events) => events.filter((e) => e.type === 'AssetV2');
  assert.deepEqual(assets(await stream()), assets(first));
  const prefix = first.slice(0, first.findIndex((e) => e.type === 'AssetV2') + 1);
  assert.equal(
    (await send('/api/sync/ack', { acks: [...prefix.map((e) => e.ack), 'AssetV2|unknown'] }, token))
      .status,
    400,
  );
  assert.deepEqual(assets(await stream()), assets(first));
  assert.equal(
    (await send('/api/sync/ack', { acks: prefix.map((e) => e.ack) }, token)).status,
    204,
  );
  const remaining = await stream();
  assert.deepEqual(assets(remaining), assets(first).slice(1));
  const all = first.map((e) => e.ack);
  const responses = await Promise.all([
    send('/api/sync/ack', { acks: all }, token),
    send('/api/sync/ack', { acks: prefix.map((e) => e.ack) }, token),
  ]);
  assert.ok(responses.every((r) => r.status === 204));
  assert.deepEqual(assets(await stream()), []);
});

test('R2 写前失败、写后响应丢失、D1 提交后响应丢失均可重复上传恢复', async () => {
  for (const fault of ['before-r2', 'after-r2', 'after-d1']) {
    const { id, token } = await reliabilityAccount();
    const failed = await uploadFixture(token, 'small.png', fault);
    assert.equal(failed.status, 503, fault);
    const intent = await db
      .prepare('SELECT id FROM upload_intents WHERE owner_id=?')
      .bind(id)
      .first();
    const asset = await db.prepare('SELECT id FROM assets WHERE owner_id=?').bind(id).first();
    assert.equal(!!asset, fault === 'after-d1');
    assert.equal(!!intent, fault !== 'after-d1');
    const retry = await uploadFixture(token);
    assert.equal(retry.status, fault === 'after-d1' ? 200 : 201);
    assert.equal((await retry.json()).id, (asset ?? intent).id);
    assert.equal((await platform.env.IMMICH_CF_MEDIA.list({ prefix: `${id}/` })).objects.length, 1);
    assert.equal(
      (await db.prepare('SELECT COUNT(*) n FROM upload_intents WHERE owner_id=?').bind(id).first())
        .n,
      0,
    );
  }
});

async function syncEvents(token, extra = {}, headers = {}) {
  const r = await worker.fetch('/api/sync/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ types: manifest.sync.requestedTypes, ...extra }),
  });
  assert.equal(r.status, 200);
  return (await r.text()).trim().split('\n').map(JSON.parse);
}
async function streamReset(token) {
  return (await syncEvents(token, { reset: true }))[0];
}
async function checkpointRows(token) {
  return (
    await worker.fetch('/api/sync/ack', { headers: { Authorization: `Bearer ${token}` } })
  ).json();
}
async function pausedSyncRequest(token, path, method, data) {
  const gate = crypto.randomUUID();
  const response = worker.fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-test-sync-gate': gate,
    },
    body: JSON.stringify(data),
  });
  const gatePath = `/__test/gates/${gate}`;
  for (let i = 0; i < 200; i++) {
    if ((await (await worker.fetch(gatePath)).json()).waiting)
      return { response, release: () => worker.fetch(gatePath, { method: 'POST' }) };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Test request did not reach transaction gate');
}

test('reset ACK 丢失重试不清除重建检查点；旧轮次普通/reset ACK 和跨会话均拒绝', async () => {
  const { token } = await reliabilityAccount();
  const initial = await syncEvents(token);
  const reset = await streamReset(token);
  assert.notEqual(reset.ack, 'SyncResetV1|reset');
  assert.deepEqual((await syncEvents(token))[0], reset); // lost reset response
  assert.equal(
    (await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token)).status,
    409,
  );
  const lost = await worker.fetch('/api/sync/ack', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-test-storage-fault': 'after-d1',
    },
    body: JSON.stringify({ acks: [reset.ack] }),
  });
  assert.equal(lost.status, 503);
  const rebuilt = await syncEvents(token);
  assert.ok(rebuilt.every((e) => e.ack.endsWith(reset.ack.slice(-37))));
  assert.equal(
    (await send('/api/sync/ack', { acks: rebuilt.map((e) => e.ack) }, token)).status,
    204,
  );
  const rows = await checkpointRows(token);
  assert.equal((await send('/api/sync/ack', { acks: [reset.ack] }, token)).status, 204);
  assert.deepEqual(await checkpointRows(token), rows);
  assert.equal(
    (await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token)).status,
    400,
  );
  const other = await reliabilityAccount();
  await syncEvents(other.token);
  assert.equal(
    (await send('/api/sync/ack', { acks: rebuilt.map((e) => e.ack) }, other.token)).status,
    400,
  );
  const next = await streamReset(token);
  assert.notEqual(next.ack, reset.ack);
  assert.equal((await send('/api/sync/ack', { acks: [reset.ack] }, token)).status, 400);
  assert.deepEqual((await syncEvents(token))[0], next);
  assert.equal(
    (await send('/api/sync/ack', { acks: [next.ack, rebuilt[0].ack] }, token)).status,
    400,
  );
  assert.equal((await send('/api/sync/ack', { acks: [next.ack] }, token)).status, 204);
});

test('确定性交错：旧 ACK/旧流/旧清除请求在 reset 完成后不能提交', async () => {
  for (const operation of ['ack', 'stream', 'clear', 'reset']) {
    const { token } = await reliabilityAccount();
    const initial = await syncEvents(token);
    const isStream = operation === 'stream' || operation === 'reset';
    const pending = await pausedSyncRequest(
      token,
      isStream ? '/api/sync/stream' : '/api/sync/ack',
      operation === 'clear' ? 'DELETE' : 'POST',
      isStream
        ? { types: manifest.sync.requestedTypes, reset: operation === 'reset' }
        : operation === 'ack'
          ? { acks: initial.map((e) => e.ack) }
          : {},
    );
    try {
      const reset = await streamReset(token);
      assert.equal((await send('/api/sync/ack', { acks: [reset.ack] }, token)).status, 204);
      const rebuilt = await syncEvents(token);
      await send('/api/sync/ack', { acks: rebuilt.map((e) => e.ack) }, token);
      const before = await checkpointRows(token);
      await pending.release();
      assert.equal((await pending.response).status, 409, operation);
      assert.deepEqual(await checkpointRows(token), before);
    } finally {
      await pending.release();
    }
  }
});

test('部分清除保留其它游标但隔离旧投递；过期投递重新发送后才可确认', async () => {
  const { token } = await reliabilityAccount();
  const initial = await syncEvents(token);
  await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token);
  const held = await pausedSyncRequest(token, '/api/sync/stream', 'POST', {
    types: manifest.sync.requestedTypes,
  });
  try {
    assert.equal((await send('/api/sync/ack', { types: ['UserV1'] }, token, 'DELETE')).status, 204);
    await held.release();
    assert.equal((await held.response).status, 409);
    const events = await syncEvents(token);
    assert.deepEqual(
      events.map((e) => e.type),
      ['UserV1', 'SyncCompleteV1'],
    );
    assert.equal((await send('/api/sync/ack', { acks: [initial[0].ack] }, token)).status, 400);
    // Determine only this session via its unique complete ACK.
    const session = await db
      .prepare('SELECT session_id FROM sync_deliveries WHERE ack=?')
      .bind(events.at(-1).ack)
      .first();
    await db
      .prepare('UPDATE sync_deliveries SET issued_at=0 WHERE session_id=?')
      .bind(session.session_id)
      .run();
    assert.equal((await send('/api/sync/ack', { acks: [events[0].ack] }, token)).status, 400);
    const fresh = await syncEvents(token);
    assert.equal(fresh[0].ack, events[0].ack);
    assert.equal(
      (await send('/api/sync/ack', { acks: fresh.map((e) => e.ack) }, token)).status,
      204,
    );
  } finally {
    await held.release();
  }
});

test('reset 确认事务失败不丢检查点，重启后恢复；撤销中的旧流不登记投递', async () => {
  const { id, token } = await reliabilityAccount();
  const initial = await syncEvents(token);
  await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token);
  const prior = await checkpointRows(token);
  const reset = await streamReset(token);
  await db
    .prepare(
      `CREATE TRIGGER test_reset_failure BEFORE UPDATE ON sessions
    WHEN OLD.user_id='${id}' AND OLD.reset_pending=1 AND NEW.reset_pending=0
    BEGIN SELECT RAISE(ABORT,'TEST_RESET_FAILURE'); END`,
    )
    .run();
  try {
    assert.equal((await send('/api/sync/ack', { acks: [reset.ack] }, token)).status, 503);
    assert.deepEqual(await checkpointRows(token), prior);
  } finally {
    await db.prepare('DROP TRIGGER test_reset_failure').run();
  }
  await worker.stop();
  worker = await unstable_dev('tests/fixtures/fault-worker.ts', config);
  assert.deepEqual((await syncEvents(token))[0], reset);
  assert.equal((await send('/api/sync/ack', { acks: [reset.ack] }, token)).status, 204);
  assert.deepEqual(await checkpointRows(token), []);
  const held = await pausedSyncRequest(token, '/api/sync/stream', 'POST', {
    types: manifest.sync.requestedTypes,
  });
  try {
    await send('/api/auth/logout', {}, token);
    await held.release();
    assert.equal((await held.response).status, 409);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM sync_guards').first()).n, 0);
  } finally {
    await held.release();
  }
});

test('并发重复 reset ACK 不清空重建结果；已完成 reset 的旧待重置流被拒绝', async () => {
  const { token } = await reliabilityAccount();
  const reset = await streamReset(token);
  const oldAck = await pausedSyncRequest(token, '/api/sync/ack', 'POST', { acks: [reset.ack] });
  const oldResetStream = await pausedSyncRequest(token, '/api/sync/stream', 'POST', {
    types: manifest.sync.requestedTypes,
  });
  try {
    assert.equal((await send('/api/sync/ack', { acks: [reset.ack] }, token)).status, 204);
    const events = await syncEvents(token);
    await send('/api/sync/ack', { acks: events.map((e) => e.ack) }, token);
    const rows = await checkpointRows(token);
    await oldAck.release();
    assert.equal((await oldAck.response).status, 204);
    assert.deepEqual(await checkpointRows(token), rows);
    await oldResetStream.release();
    assert.equal((await oldResetStream.response).status, 409);
  } finally {
    await oldAck.release();
    await oldResetStream.release();
  }
});

test('请求鉴权后会话过期，事务校验拒绝旧 ACK 且无部分写入', async () => {
  const { id, token } = await reliabilityAccount();
  const events = await syncEvents(token);
  const held = await pausedSyncRequest(token, '/api/sync/ack', 'POST', {
    acks: events.map((e) => e.ack),
  });
  try {
    await db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').bind(id).run();
    await held.release();
    assert.equal((await held.response).status, 409);
    assert.equal(
      (
        await db
          .prepare(
            'SELECT COUNT(*) n FROM sync_checkpoints WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)',
          )
          .bind(id)
          .first()
      ).n,
      0,
    );
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM sync_guards').first()).n, 0);
  } finally {
    await held.release();
  }
});
