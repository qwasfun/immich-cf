import assert from 'node:assert/strict';
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
  platform = await getPlatformProxy({
    configPath: 'wrangler.json',
    environment: 'dev',
    persist: { path: path.join(state, 'v3') },
    remoteBindings: false,
  });
  db = platform.env.IMMICH_CF_DB;
  for (const file of [
    '0001_project_metadata.sql',
    '0002_p1_identity.sql',
    '0003_session_details.sql',
    '0004_onboarding.sql',
    '0005_small_assets.sql',
  ]) {
    const sql = await readFile(`migrations/${file}`, 'utf8');
    await db.batch(
      sql
        .replace(/--[^\n]*/g, '')
        .split(/;(?!\s*END;)/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
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
  worker = await unstable_dev('src/index.ts', config);
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
  worker = await unstable_dev('src/index.ts', config);
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
    ['AuthUserV2', 'SyncCompleteV1'],
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
  assert.equal((await stream(a.token, { reset: true }))[0].type, 'SyncResetV1');
  assert.equal((await send('/api/sync/ack', { acks: ['SyncResetV1|reset'] }, a.token)).status, 204);
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
  worker = await unstable_dev('src/index.ts', config);
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
  worker = await unstable_dev('src/index.ts', config);
  assert.deepEqual(
    Buffer.from(
      await (await worker.fetch(`/api/assets/${saved.id}/original`, { headers })).arrayBuffer(),
    ),
    png,
  );
});
