import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { metadataBytes, uploadFieldCases } from '../tests/fixtures/upload-fields.mjs';
import { encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
import { curlRequest } from './lib/curl-request.mjs';
import { retryCurlUpload, readCurlRanges } from './lib/curl-recovery.mjs';

const base = 'https://immich-cf-api-dev.fun.workers.dev';
const transport = { tls12: true, proxy: 'http://127.0.0.1:7890' };
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
const bytes = await readFile('tests/fixtures/small.png');
const results = [],
  metrics = [];
let token,
  failure = null,
  complete = false,
  logout = null;
const headers = () => (token ? { Authorization: `Bearer ${token}` } : {});
async function json(path, data) {
  const r = await curlRequest(base + path, {
    ...transport,
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(data)),
  });
  metrics.push({ path, ...r.metrics });
  assert.equal(r.metrics.errorCode, null);
  return { status: r.metrics.status, bytes: r.bytes };
}
try {
  const login = await json('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = JSON.parse(login.bytes).accessToken;
  const fields = {
    metadata: metadataBytes(8192),
    ['k'.repeat(128)]: 'a'.repeat(8192 - 40),
    ...Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`extra${i}`, ''])),
  };
  let saved;
  for (const item of [
    ...uploadFieldCases(),
    { name: 'exact-boundaries', fields },
    { name: 'exact-boundaries-retry', fields },
  ]) {
    const encoded = await encodedUpload({ name: 'field-limits', bytes, fields: item.fields });
    const r = await retryCurlUpload(base + '/api/assets', {
      ...transport,
      headers: {
        ...headers(),
        'Content-Type': encoded.type,
        'x-immich-checksum': createHash('sha1').update(bytes).digest('hex'),
      },
      body: encoded.bytes,
      onAttempt: async (entry) => metrics.push({ name: item.name, ...entry }),
    });
    assert.equal(r.metrics.errorCode, null, item.name);
    const result = JSON.parse(r.bytes);
    if (item.field) {
      assert.equal(r.metrics.status, 400, item.name);
      assert.deepEqual(result.errors[0].path, [item.field]);
      assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
    } else {
      assert.ok([200, 201].includes(r.metrics.status));
      if (saved) assert.equal(result.id, saved);
      saved = result.id;
    }
    results.push({ name: item.name, status: r.metrics.status, field: item.field ?? null });
  }
  const original = await readCurlRanges(base + `/api/assets/${saved}/original`, {
    ...transport,
    headers: headers(),
    expected: bytes,
    onAttempt: async (entry) => metrics.push({ name: 'original', ...entry }),
  });
  assert.equal(original.metrics.errorCode, null);
  assert.deepEqual(original.bytes, bytes);
  const stream = await json('/api/sync/stream', {
    types: ['UsersV1', 'AssetsV2', 'AssetMetadataV1'],
  });
  assert.equal(stream.status, 200);
  const events = stream.bytes.toString().trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'SyncCompleteV1');
  assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === saved));
  assert.equal((await json('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  complete = true;
} catch {
  failure = 'PROBE_FAILED';
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      logout = (await json('/api/auth/logout', {})).status;
      assert.equal(logout, 200);
    } catch {
      logout = 'FAILED';
      process.exitCode = 1;
    }
  }
  await writeFile(
    'work/upload-fields-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        complete,
        failure,
        results,
        metrics,
        originalBytesMatch: complete,
        syncAndAck: complete,
        logout,
        officialAppVerified: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ complete, failure, cases: results.length, logout }));
}
