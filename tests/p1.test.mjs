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
  for (const file of ['0001_project_metadata.sql', '0002_p1_identity.sql']) {
    const sql = await readFile(`migrations/${file}`, 'utf8');
    await db.batch(
      sql
        .replace(/--[^\n]*/g, '')
        .split(';')
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
  assert.equal((await send('/api/assets', {})).status, 501);
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
