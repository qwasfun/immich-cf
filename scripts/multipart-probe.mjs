import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { multipartCases } from '../tests/fixtures/multipart.mjs';
import { curlRequest } from './lib/curl-request.mjs';
import { retryCurlUpload, readCurlRanges } from './lib/curl-recovery.mjs';

const base = 'https://immich-cf-api-dev.fun.workers.dev';
const transport = { tls12: true, proxy: 'http://127.0.0.1:7890' };
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
const fixture = await multipartCases();
const results = [],
  metrics = [];
let token,
  complete = false,
  failure = null,
  logout = null;
const headers = () => (token ? { Authorization: `Bearer ${token}` } : {});
async function post(path, data) {
  const r = await curlRequest(base + path, {
    ...transport,
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(data)),
  });
  metrics.push({ name: path, ...r.metrics });
  assert.equal(r.metrics.errorCode, null);
  return new Response(r.bytes?.length ? r.bytes : null, { status: r.metrics.status });
}
try {
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  let id;
  for (const item of [
    ...fixture.invalid,
    { name: 'header-exact-limit', body: fixture.headerAtLimit },
    { name: 'quoted-boundary-unicode', body: fixture.valid },
    { name: 'same-file-retry', body: fixture.valid },
  ]) {
    const r = await retryCurlUpload(base + '/api/assets', {
      ...transport,
      headers: {
        ...headers(),
        'Content-Type': fixture.type,
        'x-immich-checksum': createHash('sha1').update(fixture.bytes).digest('hex'),
      },
      body: item.body,
      onAttempt: async (entry) => metrics.push({ name: item.name, ...entry }),
    });
    assert.equal(r.metrics.errorCode, null, item.name);
    const result = JSON.parse(r.bytes);
    if (item.field) {
      assert.equal(r.metrics.status, 400, item.name);
      assert.deepEqual(result.errors[0].path, [item.field]);
    } else {
      assert.ok([200, 201].includes(r.metrics.status));
      if (id) assert.equal(result.id, id);
      id = result.id;
    }
    results.push({ name: item.name, status: r.metrics.status, field: item.field ?? null });
  }
  const original = await readCurlRanges(`${base}/api/assets/${id}/original`, {
    ...transport,
    headers: headers(),
    expected: fixture.bytes,
    onAttempt: async (entry) => metrics.push({ name: 'original', ...entry }),
  });
  assert.equal(original.metrics.errorCode, null);
  assert.deepEqual(original.bytes, fixture.bytes);
  const checked = await post('/api/assets/bulk-upload-check', {
    assets: [{ id: 'fixture', checksum: createHash('sha1').update(fixture.bytes).digest('hex') }],
  });
  assert.equal(checked.status, 200);
  assert.equal((await checked.json()).results[0].assetId, id);
  const stream = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(stream.status, 200);
  const events = (await stream.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'SyncCompleteV1');
  assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === id));
  assert.equal((await post('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  complete = true;
} catch {
  failure = 'PROBE_FAILED';
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      logout = (await post('/api/auth/logout', {})).status;
      assert.equal(logout, 200);
    } catch {
      logout = 'unconfirmed';
      process.exitCode = 1;
    }
  }
  await writeFile(
    'work/multipart-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        complete,
        failure,
        logout,
        results,
        metrics,
        originalBytesMatch: complete,
        bulkCheck: complete,
        syncAndAck: complete,
        officialAppVerified: false,
        syntheticChunkBoundaries: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ complete, failure, cases: results.length, logout }));
}
