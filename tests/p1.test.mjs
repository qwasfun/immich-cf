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
  assert.equal(reset.type, 'AuthUserV2');
  assert.equal((await send('/api/sync/ack', { acks: [reset.ack] }, a.token)).status, 204);
  assert.equal((await stream(a.token))[0].type, 'UserV1');
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
  // Exercise server-requested expiry reset separately from explicit client reset.
  const events = await syncEvents(token);
  const session = await db
    .prepare('SELECT session_id FROM sync_deliveries WHERE ack=?')
    .bind(events.at(-1).ack)
    .first();
  await db
    .prepare(
      `INSERT INTO sync_checkpoints(session_id,type,ack) VALUES (?,'SyncCompleteV1',?)
    ON CONFLICT(session_id,type) DO UPDATE SET ack=excluded.ack`,
    )
    .bind(session.session_id, 'SyncCompleteV1|00000000-0000-7000-8000-000000000000')
    .run();
  return (await syncEvents(token))[0];
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
  const reset = await streamReset(token);
  const prior = await checkpointRows(token);
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

test('真实非空同步按字节重分块、半行中断、前缀 ACK 后重连不漏资产', async () => {
  const { decodeFrozenFraming } = await import('./helpers/sync-framing.mjs');
  const { token } = await reliabilityAccount();
  assert.equal((await uploadFixture(token)).status, 201);
  assert.equal((await uploadFixture(token, 'small.jpg')).status, 201);
  const response = await send('/api/sync/stream', { types: manifest.sync.requestedTypes }, token);
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const full = decodeFrozenFraming([bytes]);
  assert.equal(full.complete, true);
  const bytewise = decodeFrozenFraming(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  assert.deepEqual(bytewise.events, full.events);
  const firstAsset = full.events.findIndex((e) => e.type === 'AssetV2');
  assert.ok(firstAsset > 0);
  const asset = full.events[firstAsset];
  assert.match(asset.data.originalFileName, /恢复测试/);
  schema(asset.data, 'SyncAssetV2');
  // Deliver first asset completely, but cut the next asset in the middle of its JSON line.
  const secondAsset = full.events.findIndex((e, i) => i > firstAsset && e.type === 'AssetV2');
  assert.ok(secondAsset > firstAsset);
  const prefix = full.events
    .slice(0, secondAsset)
    .map((e) => JSON.stringify(e) + '\n')
    .join('');
  const cut = new TextEncoder().encode(prefix).length + 13;
  const interrupted = decodeFrozenFraming([bytes.subarray(0, cut)]);
  assert.equal(interrupted.complete, false);
  assert.ok(interrupted.tail.length > 0);
  assert.equal(
    (await send('/api/sync/ack', { acks: interrupted.events.map((e) => e.ack) }, token)).status,
    204,
  );
  const resumed = await syncEvents(token);
  assert.deepEqual(
    resumed.filter((e) => e.type === 'AssetV2').map((e) => e.data.id),
    [full.events[secondAsset].data.id],
  );
  assert.equal(resumed.at(-1).type, 'SyncCompleteV1');
  assert.equal(
    (await send('/api/sync/ack', { acks: resumed.map((e) => e.ack) }, token)).status,
    204,
  );
  assert.deepEqual(
    (await syncEvents(token)).map((e) => e.type),
    ['SyncCompleteV1'],
  );
});

test('参考 3.3.1 初始化字段：OAuth 空管理地址，会话到期与 PIN 提权到期不混淆', async () => {
  const config = await (await worker.fetch('/api/server/config')).json();
  assert.equal(config.oauthAccountManagementUrl, '');
  const { token } = await reliabilityAccount();
  const response = await worker.fetch('/api/auth/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.isElevated, false);
  assert.equal(status.pinCode, false);
  assert.ok(Date.parse(status.expiresAt) > Date.now());
  assert.equal(Object.hasOwn(status, 'pinExpiresAt'), false);
  assert.equal((await worker.fetch('/api/auth/status')).status, 401);
});

test('显式 reset 直接重放用户、图片与元数据；ACK 后回到增量且隔离旧轮次', async () => {
  const { token } = await reliabilityAccount();
  assert.equal((await uploadFixture(token)).status, 201);
  await send('/api/users/me/onboarding', { isOnboarded: true }, token, 'PUT');
  const initial = await syncEvents(token);
  await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token);
  const reset = await syncEvents(token, { reset: true });
  assert.deepEqual(
    reset.map((e) => e.type),
    initial.map((e) => e.type),
  );
  assert.ok(reset.some((e) => e.type === 'AssetV2'));
  assert.ok(reset.some((e) => e.type === 'UserMetadataV1'));
  assert.equal(reset.at(-1).type, 'SyncCompleteV1');
  assert.ok(!reset.some((e) => e.type === 'SyncResetV1'));
  assert.deepEqual(await checkpointRows(token), []);
  assert.equal(
    (await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token)).status,
    400,
  );
  assert.equal((await send('/api/sync/ack', { acks: reset.map((e) => e.ack) }, token)).status, 204);
  assert.deepEqual(
    (await syncEvents(token)).map((e) => e.type),
    ['SyncCompleteV1'],
  );
  const again = await syncEvents(token, { reset: true });
  assert.notEqual(again[0].ack, reset[0].ack);
  assert.equal((await send('/api/sync/ack', { acks: reset.map((e) => e.ack) }, token)).status, 400);
});

test('显式 reset 与旧 ACK、流、清除及另一个 reset 交错：旧事务不能写回', async () => {
  for (const operation of ['ack', 'stream', 'clear', 'reset']) {
    const { token } = await reliabilityAccount();
    const initial = await syncEvents(token);
    const isStream = ['stream', 'reset'].includes(operation);
    const held = await pausedSyncRequest(
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
      const reset = await syncEvents(token, { reset: true });
      await send('/api/sync/ack', { acks: reset.map((e) => e.ack) }, token);
      const before = await checkpointRows(token);
      await held.release();
      assert.equal((await held.response).status, 409, operation);
      assert.deepEqual(await checkpointRows(token), before);
    } finally {
      await held.release();
    }
  }
});

test('显式 reset 接管待重置会话，拒绝并发旧 reset ACK 和待重置流', async () => {
  const { token } = await reliabilityAccount();
  const control = await streamReset(token);
  const heldAck = await pausedSyncRequest(token, '/api/sync/ack', 'POST', { acks: [control.ack] });
  const heldStream = await pausedSyncRequest(token, '/api/sync/stream', 'POST', {
    types: manifest.sync.requestedTypes,
  });
  try {
    const reset = await syncEvents(token, { reset: true });
    assert.equal(reset[0].type, 'AuthUserV2');
    await send('/api/sync/ack', { acks: reset.map((e) => e.ack) }, token);
    const before = await checkpointRows(token);
    await heldAck.release();
    assert.equal((await heldAck.response).status, 409);
    await heldStream.release();
    assert.equal((await heldStream.response).status, 409);
    assert.equal((await send('/api/sync/ack', { acks: [control.ack] }, token)).status, 400);
    assert.deepEqual(await checkpointRows(token), before);
  } finally {
    await heldAck.release();
    await heldStream.release();
  }
});

test('显式 reset 事务失败全部回滚；提交后响应丢失与进程重启可恢复快照', async () => {
  const { id, token } = await reliabilityAccount();
  const initial = await syncEvents(token);
  await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token);
  const before = await checkpointRows(token);
  const stateBefore = await db.prepare('SELECT * FROM sessions WHERE user_id=?').bind(id).first();
  await db
    .prepare(
      `CREATE TRIGGER test_explicit_reset_failure BEFORE INSERT ON sync_deliveries
    WHEN NEW.session_id='${stateBefore.id}' BEGIN SELECT RAISE(ABORT,'TEST_RESET_FAILURE'); END`,
    )
    .run();
  try {
    assert.equal(
      (await send('/api/sync/stream', { types: manifest.sync.requestedTypes, reset: true }, token))
        .status,
      503,
    );
    assert.deepEqual(await checkpointRows(token), before);
    assert.deepEqual(
      await db.prepare('SELECT * FROM sessions WHERE user_id=?').bind(id).first(),
      stateBefore,
    );
  } finally {
    await db.prepare('DROP TRIGGER test_explicit_reset_failure').run();
  }
  const lost = await worker.fetch('/api/sync/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-test-storage-fault': 'after-d1',
    },
    body: JSON.stringify({ types: manifest.sync.requestedTypes, reset: true }),
  });
  assert.equal(lost.status, 503);
  assert.deepEqual(await checkpointRows(token), []);
  await worker.stop();
  worker = await unstable_dev('tests/fixtures/fault-worker.ts', config);
  const recovered = await syncEvents(token);
  assert.deepEqual(
    recovered.map((e) => e.type),
    initial.map((e) => e.type),
  );
  assert.equal(
    (await send('/api/sync/ack', { acks: recovered.map((e) => e.ack) }, token)).status,
    204,
  );
  assert.equal(
    (await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token)).status,
    400,
  );
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM sync_guards').first()).n, 0);
});

test('旧 ACK 先提交也不裁剪显式 reset 快照；请求类型过滤及无效字段不修改状态', async () => {
  const { token } = await reliabilityAccount();
  const initial = await syncEvents(token);
  const held = await pausedSyncRequest(token, '/api/sync/stream', 'POST', {
    types: manifest.sync.requestedTypes,
    reset: true,
  });
  try {
    assert.equal(
      (await send('/api/sync/ack', { acks: initial.map((e) => e.ack) }, token)).status,
      204,
    );
    await held.release();
    const response = await held.response;
    assert.equal(response.status, 200);
    const reset = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      reset.map((e) => e.type),
      initial.map((e) => e.type),
    );
    assert.equal(
      (await send('/api/sync/ack', { acks: reset.map((e) => e.ack) }, token)).status,
      204,
    );
    const before = await checkpointRows(token);
    for (const input of [
      { types: [], reset: 'yes' },
      { types: ['invalid'], reset: true },
    ]) {
      assert.equal((await send('/api/sync/stream', input, token)).status, 400);
      assert.deepEqual(await checkpointRows(token), before);
    }
    assert.deepEqual(
      (await syncEvents(token, { types: ['UsersV1'], reset: true })).map((e) => e.type),
      ['UserV1', 'SyncCompleteV1'],
    );
    assert.deepEqual(await checkpointRows(token), []);
  } finally {
    await held.release();
  }
});

test('非空图库共享契约：两种图片、元数据、重复上传、未 ACK 重放及 reset 后媒体闭环', async () => {
  const { compareNonempty } = await import('../scripts/reference-nonempty.mjs');
  const { token } = await reliabilityAccount();
  const report = await compareNonempty({
    targets: { immichCf: (url, options) => worker.fetch(url, options) },
    tokens: { immichCf: token },
    shape: (value) => Object.keys(value).sort(),
    request: async (fetcher, url, method, data, accessToken) => {
      const response = await fetcher(url, {
        method,
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(data),
      });
      const text = await response.text();
      return {
        status: response.status,
        value: !text
          ? null
          : response.headers.get('content-type')?.includes('jsonlines')
            ? text.trim().split('\n').map(JSON.parse)
            : JSON.parse(text),
      };
    },
  });
  assert.equal(report.targets.immichCf.media.length, 2);
});

test('非空图库部分 ACK：后续资产不丢失，用户游标不被推进', async () => {
  const { token } = await reliabilityAccount();
  await uploadFixture(token, 'small.png');
  await uploadFixture(token, 'small.jpg');
  const initial = await syncEvents(token);
  const assets = initial.filter((e) => e.type === 'AssetV2');
  assert.equal(assets.length, 2);
  assert.equal((await send('/api/sync/ack', { acks: [assets[0].ack] }, token)).status, 204);
  const replay = await syncEvents(token);
  assert.deepEqual(
    replay.filter((e) => e.type === 'AssetV2').map((e) => e.data.id),
    [assets[1].data.id],
  );
  assert.ok(replay.some((e) => e.type === 'UserV1'));
  const reset = await syncEvents(token, { reset: true });
  assert.equal(reset.filter((e) => e.type === 'AssetV2').length, 2);
});

test('完整家族同步只读取一次检查点，元数据删除、reset 与增量语义不变', async () => {
  const { token } = await reliabilityAccount();
  await uploadFixture(token);
  await send('/api/users/me/onboarding', { isOnboarded: true }, token, 'PUT');
  const pull = async (reset) => {
    const r = await worker.fetch('/api/sync/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-test-count-checkpoints': '1',
      },
      body: JSON.stringify({ types: manifest.sync.requestedTypes, reset }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-test-checkpoint-reads'), reset ? '0' : '1');
    assert.equal(r.headers.get('x-test-delivery-writes'), '1');
    return (await r.text()).trim().split('\n').map(JSON.parse);
  };
  const events = await pull(true);
  assert.ok(events.some((e) => e.type === 'UserMetadataV1'));
  assert.ok(events.some((e) => e.type === 'AssetV2'));
  await send('/api/sync/ack', { acks: events.map((e) => e.ack) }, token);
  assert.deepEqual(
    (await pull(false)).map((e) => e.type),
    ['SyncCompleteV1'],
  );
  await send('/api/users/me/onboarding', {}, token, 'DELETE');
  const deleted = await pull(false);
  assert.deepEqual(
    deleted.map((e) => e.type),
    ['UserMetadataDeleteV1', 'SyncCompleteV1'],
  );
});

test('连续五次 reset 保持非空资产集合，旧代 ACK 被拒绝且本代 ACK 后为空增量', async () => {
  const { token } = await reliabilityAccount();
  await uploadFixture(token, 'small.png');
  await uploadFixture(token, 'small.jpg');
  let previous;
  let ids;
  for (let i = 0; i < 5; i++) {
    const events = await syncEvents(token, { reset: true });
    const current = events
      .filter((e) => e.type === 'AssetV2')
      .map((e) => e.data.id)
      .sort();
    assert.equal(current.length, 2);
    assert.equal(new Set(current).size, 2);
    if (ids) assert.deepEqual(current, ids);
    ids = current;
    if (previous) {
      assert.equal((await send('/api/sync/ack', { acks: previous }, token)).status, 400);
      assert.deepEqual(await checkpointRows(token), []);
    }
    const acks = events.map((e) => e.ack);
    assert.equal((await send('/api/sync/ack', { acks }, token)).status, 204);
    assert.deepEqual(
      (await syncEvents(token)).map((e) => e.type),
      ['SyncCompleteV1'],
    );
    previous = acks;
  }
});

test('私有媒体支持 Range、HEAD、ETag，条件请求不能绕过归属和会话撤销', async () => {
  const { token } = await reliabilityAccount();
  const saved = await (await uploadFixture(token)).json();
  const bytes = await readFile('tests/fixtures/small.png');
  const url = `/api/assets/${saved.id}/original`;
  const get = (extra = {}, method = 'GET', auth = token) =>
    worker.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${auth}`, ...extra },
    });
  const full = await get();
  const etag = full.headers.get('etag');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  for (const [value, begin, end] of [
    ['bytes=0-7', 0, 8],
    ['bytes=8-', 8, bytes.length],
    ['bytes=-8', bytes.length - 8, bytes.length],
    ['bytes=0-999999', 0, bytes.length],
  ]) {
    const r = await get({ Range: value });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes ${begin}-${end - 1}/${bytes.length}`);
    assert.equal(r.headers.get('content-length'), String(end - begin));
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(begin, end));
  }
  for (const value of [`bytes=${bytes.length}-`, 'bytes=-0', 'bytes=8-2']) {
    const r = await get({ Range: value });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), `bytes */${bytes.length}`);
  }
  for (const value of ['bytes=0-1,4-5', 'garbage', 'bytes=90071992547409999-']) {
    assert.equal((await get({ Range: value })).status, 200);
  }
  assert.equal((await get({ Range: 'bytes=0-7', 'If-Range': etag })).status, 206);
  assert.equal((await get({ Range: 'bytes=0-7', 'If-Range': '"stale"' })).status, 200);
  assert.equal((await get({ Range: 'bytes=0-7', 'If-Range': `W/${etag}` })).status, 200);
  for (const tag of [etag, `W/${etag}`, '*', `"other", ${etag}`]) {
    const r = await get({ 'If-None-Match': tag, Range: 'bytes=0-7' });
    assert.equal(r.status, 304);
    assert.equal(await r.text(), '');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  const head = await get({ Range: 'bytes=0-7' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(await head.text(), '');
  const other = await reliabilityAccount();
  const denied = await get({ 'If-None-Match': etag }, 'GET', other.token);
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get('etag'), null);
  await send('/api/auth/logout', {}, token);
  assert.equal((await get({ 'If-None-Match': etag })).status, 401);
});

async function uploadBytes(token, bytes) {
  const form = new FormData();
  form.set('assetData', new File([bytes], '混合队列.png'));
  form.set('fileCreatedAt', '2026-10-15T00:00:00Z');
  form.set('fileModifiedAt', '2026-10-15T00:00:00Z');
  const encoded = new Request('http://localhost/api/assets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return worker.fetch('/api/assets', {
    method: 'POST',
    headers: Object.fromEntries(encoded.headers),
    body: await encoded.arrayBuffer(),
  });
}

test('PNG CRC 损坏和超限不入库、不预约；随后有效图片仍可上传同步', async () => {
  const { id, token } = await reliabilityAccount();
  const png = await readFile('tests/fixtures/small.png');
  assert.equal((await uploadBytes(token, png)).status, 201);
  const broken = Buffer.from(png);
  broken[29] ^= 1; // IHDR CRC, not dimensions.
  const corrupt = await uploadBytes(token, broken);
  assert.equal(corrupt.status, 400);
  const error = await corrupt.json();
  assert.match(JSON.stringify(error), /assetData/);
  assert.match(JSON.stringify(error), /校验和/);
  assert.equal((await uploadBytes(token, Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
  for (const value of ['....ftypheic', '....ftypisom', 'GIF89a', '<svg/>']) {
    assert.equal((await uploadBytes(token, Buffer.from(value))).status, 400);
  }
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM upload_intents WHERE owner_id=?').bind(id).first()).n,
    0,
  );
  assert.equal((await uploadBytes(token, await readFile('tests/fixtures/small.jpg'))).status, 201);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=?').bind(id).first()).n,
    2,
  );
  assert.equal((await syncEvents(token)).filter((e) => e.type === 'AssetV2').length, 2);
});

test('100 个 JPEG/PNG 合成变体原图字节一致，重复重试不增加资产', async () => {
  const { crc32 } = await import('node:zlib');
  const png = await readFile('tests/fixtures/small.png');
  const jpg = await readFile('tests/fixtures/small.jpg');
  for (let group = 0; group < 5; group++) {
    const { id, token } = await reliabilityAccount();
    for (let index = 0; index < 20; index++) {
      const payload = Buffer.from(`Comment\0sample-${group * 20 + index}`);
      let bytes;
      if (index % 2 === 0) {
        const chunk = Buffer.alloc(payload.length + 12);
        chunk.writeUInt32BE(payload.length);
        chunk.write('tEXt', 4);
        payload.copy(chunk, 8);
        chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
        bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
      } else {
        const comment = Buffer.alloc(payload.length + 4);
        comment[0] = 255;
        comment[1] = 254;
        comment.writeUInt16BE(payload.length + 2, 2);
        payload.copy(comment, 4);
        bytes = Buffer.concat([jpg.subarray(0, 2), comment, jpg.subarray(2)]);
      }
      const uploaded = await uploadBytes(token, bytes);
      assert.equal(uploaded.status, 201);
      const saved = await uploaded.json();
      const repeat = await uploadBytes(token, bytes);
      assert.equal(repeat.status, 200);
      assert.equal((await repeat.json()).id, saved.id);
      const original = await worker.fetch(`/api/assets/${saved.id}/original`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(original.status, 200);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    }
    assert.equal(
      (await db.prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=?').bind(id).first()).n,
      20,
    );
    assert.equal((await syncEvents(token)).filter((e) => e.type === 'AssetV2').length, 20);
  }
});

test('JPEG/PNG EXIF 1–8 双字节序：布局尺寸、Sync、重复与原图预览字节一致', async () => {
  const { tiff, withExif } = await import('./fixtures/exif.mjs');
  for (const format of ['jpg', 'png']) {
    const source = await readFile(`tests/fixtures/small.${format}`);
    for (const little of [true, false]) {
      const { token } = await reliabilityAccount();
      const headers = { Authorization: `Bearer ${token}` };
      const baseline = await (await uploadBytes(token, source)).json();
      const base = await (await worker.fetch(`/api/assets/${baseline.id}`, { headers })).json();
      const expected = new Map();
      for (let orientation = 1; orientation <= 8; orientation++) {
        const bytes = withExif(source, tiff(orientation, little), format);
        const response = await uploadBytes(token, bytes);
        assert.equal(response.status, 201);
        const saved = await response.json();
        const dimensions = orientation >= 5 ? [base.height, base.width] : [base.width, base.height];
        expected.set(saved.id, dimensions);
        const info = await (await worker.fetch(`/api/assets/${saved.id}`, { headers })).json();
        assert.deepEqual([info.width, info.height], dimensions);
        assert.equal((await (await uploadBytes(token, bytes)).json()).id, saved.id);
        for (const path of ['original', 'thumbnail?size=preview']) {
          const media = await worker.fetch(`/api/assets/${saved.id}/${path}`, { headers });
          assert.deepEqual(Buffer.from(await media.arrayBuffer()), bytes);
        }
      }
      for (const reset of [false, true]) {
        const events = await syncEvents(token, { reset });
        for (const event of events.filter((e) => expected.has(e.data.id))) {
          assert.deepEqual([event.data.width, event.data.height], expected.get(event.data.id));
        }
        assert.equal(events.filter((e) => expected.has(e.data.id)).length, 8);
        assert.equal(
          (await send('/api/sync/ack', { acks: events.map((e) => e.ack) }, token)).status,
          204,
        );
      }
    }
  }
});

test('EXIF 越界、非法方向、字段类型/数量与重复块拒绝且不预留存储', async () => {
  const { tiff, withExif } = await import('./fixtures/exif.mjs');
  const { id, token } = await reliabilityAccount();
  const jpg = await readFile('tests/fixtures/small.jpg');
  const invalid = [Buffer.alloc(0), tiff(0), tiff(9), tiff(6).subarray(0, 20)];
  for (const [offset, value] of [
    [0, 0],
    [2, 43],
    [4, 255],
    [8, 255],
    [12, 4],
    [14, 2],
  ]) {
    const data = tiff(6);
    data[offset] = value;
    invalid.push(data);
  }
  const images = invalid.map((data) => withExif(jpg, data));
  images.push(withExif(withExif(jpg, tiff(6)), tiff(8)));
  for (const bytes of images) {
    const r = await uploadBytes(token, bytes);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /assetData.*EXIF/);
  }
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=?').bind(id).first()).n,
    0,
  );
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM upload_intents WHERE owner_id=?').bind(id).first()).n,
    0,
  );
  assert.equal((await uploadBytes(token, jpg)).status, 201);
});

async function historicalExif() {
  const { token, id: owner } = await reliabilityAccount();
  const { tiff, withExif } = await import('./fixtures/exif.mjs');
  const bytes = withExif(await readFile('tests/fixtures/small.png'), tiff(6), 'png');
  const saved = await (await uploadBytes(token, bytes)).json();
  await db.prepare('UPDATE assets SET width=320,height=240 WHERE id=?').bind(saved.id).run();
  return { token, owner, id: saved.id, bytes };
}
const repairPath = '/api/immich-cf/repair-dimensions';

test('混合队列精确大小边界、格式拒绝、重复失败与截断恢复无孤儿', async () => {
  const { mixedCases, encodedUpload } = await import('./fixtures/mixed-queue.mjs');
  const { id, token } = await reliabilityAccount();
  const items = await mixedCases();
  const submit = async (item, truncate = false) => {
    const encoded = await encodedUpload(item);
    const data = truncate ? encoded.bytes.subarray(0, encoded.bytes.length - 40) : encoded.bytes;
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= data.length) {
          controller.close();
          return;
        }
        controller.enqueue(data.subarray(offset, offset + 16384));
        offset += 16384;
      },
    });
    return worker.fetch('/api/assets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': encoded.type,
      },
      body: stream,
      duplex: 'half',
    });
  };
  const saved = [];
  for (const item of items) {
    const r = await submit(item);
    assert.equal(r.status, item.status, item.name);
    const result = await r.json();
    if (item.field) {
      assert.deepEqual(result.errors[0].path, [item.field]);
      assert.equal((await submit(item)).status, item.status);
    } else saved.push({ id: result.id, bytes: item.bytes });
  }
  const interrupted = await submit(items[0], true);
  assert.equal(interrupted.status, 400);
  assert.deepEqual((await interrupted.json()).errors[0].path, ['assetData']);
  const rejected = items.filter((i) => i.field);
  const concurrent = await Promise.all(rejected.map((item) => submit(item)));
  assert.deepEqual(
    concurrent.map((r) => r.status),
    rejected.map((i) => i.status),
  );
  assert.equal((await submit(items[0])).status, 200);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=?').bind(id).first()).n,
    4,
  );
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM upload_intents WHERE owner_id=?').bind(id).first()).n,
    0,
  );
  assert.equal((await platform.env.IMMICH_CF_MEDIA.list({ prefix: `${id}/` })).objects.length, 4);
  for (const asset of saved) {
    const response = await worker.fetch(`/api/assets/${asset.id}/original`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.bytes);
  }
  const events = await syncEvents(token);
  assert.equal(events.filter((e) => e.type === 'AssetV2').length, 4);
  await send('/api/sync/ack', { acks: events.map((e) => e.ack) }, token);
  assert.deepEqual(
    (await syncEvents(token)).map((e) => e.type),
    ['SyncCompleteV1'],
  );
});

test('历史尺寸预检无写入，修复推进游标，旧流 ACK 不吞更新，重试不再推进', async () => {
  const { token, id, bytes } = await historicalExif();
  const prior = await syncEvents(token);
  await send('/api/sync/ack', { acks: prior.map((e) => e.ack) }, token);
  const read = () => db.prepare('SELECT * FROM assets WHERE id=?').bind(id).first();
  const before = await read();
  assert.equal((await (await send(repairPath, { id }, token)).json()).changed, true);
  assert.deepEqual(await read(), before);
  const held = await pausedSyncRequest(token, '/api/sync/stream', 'POST', {
    types: manifest.sync.requestedTypes,
    reset: true,
  });
  try {
    assert.equal((await (await send(repairPath, { id, apply: true }, token)).json()).applied, true);
    await held.release();
    const old = (await (await held.response).text()).trim().split('\n').map(JSON.parse);
    assert.equal((await send('/api/sync/ack', { acks: old.map((e) => e.ack) }, token)).status, 204);
    const fresh = await syncEvents(token);
    const asset = fresh.find((e) => e.type === 'AssetV2' && e.data.id === id);
    assert.deepEqual([asset.data.width, asset.data.height], [240, 320]);
    assert.equal(
      (await send('/api/sync/ack', { acks: fresh.map((e) => e.ack) }, token)).status,
      204,
    );
    assert.deepEqual(
      (await syncEvents(token)).map((e) => e.type),
      ['SyncCompleteV1'],
    );
    const after = await read();
    assert.ok(after.sync_seq > before.sync_seq);
    assert.equal(after.seq, before.seq);
    assert.equal(
      (await (await send(repairPath, { id, apply: true }, token)).json()).changed,
      false,
    );
    assert.equal((await read()).sync_seq, after.sync_seq);
    const original = await worker.fetch(`/api/assets/${id}/original`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  } finally {
    await held.release();
  }
});

test('历史修复 CAS 并发、跨用户和事务时撤销隔离', async () => {
  const { token, id } = await historicalExif();
  const other = await reliabilityAccount();
  assert.equal((await send(repairPath, { id, apply: true }, other.token)).status, 404);
  const held = await pausedSyncRequest(token, repairPath, 'POST', { id, apply: true });
  try {
    assert.equal((await send(repairPath, { id, apply: true }, token)).status, 200);
    const seq = (await db.prepare('SELECT sync_seq FROM assets WHERE id=?').bind(id).first())
      .sync_seq;
    await held.release();
    assert.equal((await held.response).status, 409);
    assert.equal(
      (await db.prepare('SELECT sync_seq FROM assets WHERE id=?').bind(id).first()).sync_seq,
      seq,
    );
  } finally {
    await held.release();
  }
  await db.prepare('UPDATE assets SET width=320,height=240 WHERE id=?').bind(id).run();
  const revoked = await pausedSyncRequest(token, repairPath, 'POST', { id, apply: true });
  try {
    await send('/api/auth/logout', {}, token);
    await revoked.release();
    assert.equal((await revoked.response).status, 409);
    assert.equal(
      (await db.prepare('SELECT width FROM assets WHERE id=?').bind(id).first()).width,
      320,
    );
  } finally {
    await revoked.release();
  }
});

test('尺寸修复事务失败回滚，成功响应丢失后重试不产生额外同步版本', async () => {
  const { token, id } = await historicalExif();
  const before = await db.prepare('SELECT width,sync_seq FROM assets WHERE id=?').bind(id).first();
  await db
    .prepare(
      "CREATE TRIGGER test_repair_failure AFTER UPDATE OF width ON assets WHEN NEW.width=240 BEGIN SELECT RAISE(ABORT,'TEST_REPAIR'); END",
    )
    .run();
  try {
    assert.equal((await send(repairPath, { id, apply: true }, token)).status, 503);
    assert.deepEqual(
      await db.prepare('SELECT width,sync_seq FROM assets WHERE id=?').bind(id).first(),
      before,
    );
  } finally {
    await db.prepare('DROP TRIGGER test_repair_failure').run();
  }
  const lost = await worker.fetch(repairPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-test-storage-fault': 'after-d1',
    },
    body: JSON.stringify({ id, apply: true }),
  });
  assert.equal(lost.status, 503);
  const committed = await db
    .prepare('SELECT width,sync_seq FROM assets WHERE id=?')
    .bind(id)
    .first();
  assert.equal(committed.width, 240);
  assert.equal((await send(repairPath, { id, apply: true }, token)).status, 200);
  assert.deepEqual(
    await db.prepare('SELECT width,sync_seq FROM assets WHERE id=?').bind(id).first(),
    committed,
  );
});

test('两会话旧 ACK 后均收到尺寸修复；缺失或校验不符原图不修改尺寸', async () => {
  const { token, owner, id } = await historicalExif();
  const { createHash } = await import('node:crypto');
  const second = crypto.randomUUID().replaceAll('-', '').repeat(2);
  await db
    .prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
    .bind(
      crypto.randomUUID(),
      owner,
      createHash('sha256').update(second).digest('hex'),
      Date.now() + 86400000,
    )
    .run();
  for (const session of [token, second]) {
    const events = await syncEvents(session);
    await send('/api/sync/ack', { acks: events.map((e) => e.ack) }, session);
  }
  const row = await db.prepare('SELECT * FROM assets WHERE id=?').bind(id).first();
  await db.prepare('UPDATE assets SET checksum=? WHERE id=?').bind('invalid', id).run();
  assert.equal((await send(repairPath, { id, apply: true }, token)).status, 409);
  await db.prepare('UPDATE assets SET checksum=? WHERE id=?').bind(row.checksum, id).run();
  const original = await (await platform.env.IMMICH_CF_MEDIA.get(row.object_key)).arrayBuffer();
  await platform.env.IMMICH_CF_MEDIA.delete(row.object_key);
  assert.equal((await send(repairPath, { id, apply: true }, token)).status, 503);
  assert.equal(
    (await db.prepare('SELECT sync_seq FROM assets WHERE id=?').bind(id).first()).sync_seq,
    row.sync_seq,
  );
  await platform.env.IMMICH_CF_MEDIA.put(row.object_key, original);
  assert.equal((await send(repairPath, { id, apply: true }, token)).status, 200);
  for (const session of [token, second]) {
    const events = await syncEvents(session);
    const asset = events.find((e) => e.type === 'AssetV2' && e.data.id === id);
    assert.deepEqual([asset.data.width, asset.data.height], [240, 320]);
  }
});
