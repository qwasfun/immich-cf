import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { getPlatformProxy, unstable_dev } from 'wrangler';

// The reference target is deliberately fixed to our isolated local Compose deployment.
const reference = 'http://127.0.0.1:22830';
const manifest = JSON.parse(await readFile('docs/compatibility-manifest.json', 'utf8'));
const expectedImage = `${manifest.referenceServer.image}@${manifest.referenceServer.platformDigests['linux/amd64']}`;
assert.equal(
  execFileSync(
    'docker',
    ['inspect', '--format', '{{.Config.Image}}', 'immich-cf-reference-server-1'],
    { encoding: 'utf8' },
  ).trim(),
  expectedImage,
  'Reference container must use frozen image digest',
);
const state = path.resolve('work', `reference-compare-${randomUUID()}`);
await mkdir(state, { recursive: true });
const shape = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value))
    return [...new Set(value.map((item) => JSON.stringify(shape(item))))].sort().map(JSON.parse);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape(value[key])]),
    );
  return typeof value;
};
const report = {
  upstreamCommit: manifest.upstream.commit,
  image: manifest.referenceServer.platformDigests['linux/amd64'],
  scope: 'isolated-empty-library-http-and-sync',
  gate: 'comparison-only-not-full-compatibility',
  cases: [],
};
async function request(fetcher, endpoint, method = 'GET', data, token) {
  const response = await fetcher(endpoint, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  const value = !text
    ? null
    : response.headers.get('content-type')?.includes('jsonlines')
      ? text.trim().split('\n').map(JSON.parse)
      : JSON.parse(text);
  return { status: response.status, value };
}
const refFetch = (endpoint, options) => fetch(`${reference}${endpoint}`, options);
const version = await request(refFetch, '/api/server/version');
assert.deepEqual(
  [version.value.major, version.value.minor, version.value.patch],
  [3, 3, 1],
  'Reference must be frozen v3.3.1',
);
let admin;
try {
  admin = JSON.parse(await readFile('work/reference-admin.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  admin = {
    email: 'admin@immich-cf-reference.test',
    name: 'Reference admin',
    password: randomBytes(32).toString('hex'),
  };
  await writeFile('work/reference-admin.json', JSON.stringify(admin));
}
let adminLogin = await request(refFetch, '/api/auth/login', 'POST', {
  email: admin.email,
  password: admin.password,
});
if (adminLogin.status !== 201) {
  const signup = await request(refFetch, '/api/auth/admin-sign-up', 'POST', admin);
  assert.equal(signup.status, 201, 'Reference admin initialization failed; inspect isolated setup');
  adminLogin = await request(refFetch, '/api/auth/login', 'POST', {
    email: admin.email,
    password: admin.password,
  });
}
assert.equal(adminLogin.status, 201);
const identity = {
  email: `case-${randomUUID()}@immich-cf-reference.test`,
  name: '协议测试',
  password: randomBytes(32).toString('hex'),
};
try {
  const created = await request(
    refFetch,
    '/api/admin/users',
    'POST',
    { ...identity, isAdmin: false, notify: false, shouldChangePassword: false },
    adminLogin.value.accessToken,
  );
  assert.equal(created.status, 201, 'Reference test user creation failed');
} finally {
  await request(refFetch, '/api/auth/logout', 'POST', {}, adminLogin.value.accessToken);
}
const require = createRequire(import.meta.url);
const cli = path.resolve(path.dirname(require.resolve('wrangler')), '../bin/wrangler.js');
let platform, worker;
const tokens = {};
try {
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
  await platform.env.IMMICH_CF_DB.prepare(
    'INSERT INTO users (id,email,name,password_hash,created_at,update_id) VALUES (?,?,?,?,?,?)',
  )
    .bind(
      randomUUID(),
      identity.email,
      identity.name,
      await bcrypt.hash(identity.password, 12),
      new Date().toISOString(),
      '019e0000-0000-7000-8000-000000000001',
    )
    .run();
  worker = await unstable_dev('src/index.ts', {
    config: 'wrangler.json',
    env: 'dev',
    local: true,
    ip: '127.0.0.1',
    port: 0,
    persist: true,
    persistTo: state,
    vars: { ENABLE_P1_POC: 'true' },
    experimental: { disableExperimentalWarning: true, forceLocal: true, watch: false },
  });
  const targets = {
    reference: refFetch,
    immichCf: (endpoint, options) => worker.fetch(endpoint, options),
  };
  const observe = async (
    name,
    endpoint,
    method = 'GET',
    data,
    authenticated = false,
    project = shape,
  ) => {
    const entry = { name, endpoint, method };
    for (const [key, fetcher] of Object.entries(targets)) {
      const result = await request(
        fetcher,
        endpoint,
        method,
        data,
        authenticated ? tokens[key] : undefined,
      );
      entry[key] = { status: result.status, body: project(result.value) };
    }
    entry.equal = isDeepStrictEqual(entry.reference, entry.immichCf);
    report.cases.push(entry);
  };
  await observe('version', '/api/server/version', 'GET', undefined, false, (value) => value);
  await observe('features', '/api/server/features', 'GET', undefined, false, (value) => value);
  await observe('config', '/api/server/config');
  await observe('config-values', '/api/server/config', 'GET', undefined, false, (value) =>
    Object.fromEntries(
      [
        'publicUsers',
        'isInitialized',
        'isOnboarded',
        'trashDays',
        'minFaces',
        'userDeleteDelay',
        'oauthAccountManagementUrl',
      ].map((key) => [key, value[key]]),
    ),
  );
  await observe('unauthorized-user', '/api/users/me');
  await observe('wrong-password', '/api/auth/login', 'POST', {
    email: identity.email,
    password: 'wrong',
  });
  const logins = { name: 'login', endpoint: '/api/auth/login', method: 'POST' };
  for (const [key, fetcher] of Object.entries(targets)) {
    const result = await request(fetcher, '/api/auth/login', 'POST', {
      email: identity.email,
      password: identity.password,
    });
    assert.equal(result.status, 201, `${key} login failed`);
    tokens[key] = result.value.accessToken;
    logins[key] = { status: result.status, body: shape(result.value) };
  }
  logins.equal = isDeepStrictEqual(logins.reference, logins.immichCf);
  report.cases.push(logins);
  await observe('auth-status', '/api/auth/status', 'GET', undefined, true);
  await observe('validate-token', '/api/auth/validateToken', 'POST', {}, true, (value) => value);
  await observe('current-user', '/api/users/me', 'GET', undefined, true);
  await observe(
    'preferences',
    '/api/users/me/preferences',
    'GET',
    undefined,
    true,
    (value) => value,
  );
  await observe('onboarding', '/api/users/me/onboarding', 'GET', undefined, true, (value) => value);
  await observe('sessions', '/api/sessions', 'GET', undefined, true);
  for (const [key, fetcher] of Object.entries(targets)) {
    const initial = await request(
      fetcher,
      '/api/sync/stream',
      'POST',
      { types: manifest.sync.requestedTypes },
      tokens[key],
    );
    assert.equal(initial.status, 200, `${key} initial stream failed`);
    const summarize = (value) =>
      value.map((event) => ({
        type: event.type,
        data: shape(event.data),
        ackParts: event.ack.split('|').length,
      }));
    const initialRow = report.cases.find((row) => row.name === 'initial-stream') ?? {
      name: 'initial-stream',
      endpoint: '/api/sync/stream',
      method: 'POST',
    };
    if (!report.cases.includes(initialRow)) report.cases.push(initialRow);
    initialRow[key] = { status: initial.status, body: summarize(initial.value) };
    assert.equal(initial.value.at(-1).type, 'SyncCompleteV1');
    const ack = await request(
      fetcher,
      '/api/sync/ack',
      'POST',
      { acks: initial.value.map((e) => e.ack) },
      tokens[key],
    );
    assert.equal(ack.status, 204, `${key} initial ACK failed`);
    const incremental = await request(
      fetcher,
      '/api/sync/stream',
      'POST',
      { types: manifest.sync.requestedTypes },
      tokens[key],
    );
    const row = report.cases.find((row) => row.name === 'incremental-stream') ?? {
      name: 'incremental-stream',
      endpoint: '/api/sync/stream',
      method: 'POST',
    };
    if (!report.cases.includes(row)) report.cases.push(row);
    row[key] = { status: incremental.status, body: summarize(incremental.value) };
    const reset = await request(
      fetcher,
      '/api/sync/stream',
      'POST',
      { types: manifest.sync.requestedTypes, reset: true },
      tokens[key],
    );
    const resetRow = report.cases.find((row) => row.name === 'reset-stream') ?? {
      name: 'reset-stream',
      endpoint: '/api/sync/stream',
      method: 'POST',
    };
    if (!report.cases.includes(resetRow)) report.cases.push(resetRow);
    resetRow[key] = { status: reset.status, body: summarize(reset.value) };
    const resetAck = reset.value.find((event) => event.type === 'SyncResetV1')?.ack;
    if (resetAck)
      assert.equal(
        (await request(fetcher, '/api/sync/ack', 'POST', { acks: [resetAck] }, tokens[key])).status,
        204,
      );
  }
  for (const row of report.cases) row.equal = isDeepStrictEqual(row.reference, row.immichCf);
  await writeFile('work/reference-comparison.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      report.cases.map((row) => ({
        case: row.name,
        equal: row.equal,
        referenceStatus: row.reference.status,
        immichCfStatus: row.immichCf.status,
      })),
      null,
      2,
    ),
  );
} finally {
  for (const [key, token] of Object.entries(tokens)) {
    try {
      await request(
        key === 'reference' ? refFetch : (endpoint, options) => worker.fetch(endpoint, options),
        '/api/auth/logout',
        'POST',
        {},
        token,
      );
    } catch {
      console.error(`${key} test logout failed`);
    }
  }
  try {
    await worker?.stop();
  } finally {
    await platform?.dispose();
  }
}
