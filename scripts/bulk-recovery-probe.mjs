import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
import { curlRequest } from './lib/curl-request.mjs';
import { retryCurlUpload, readCurlRanges } from './lib/curl-recovery.mjs';
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const transport = { tls12: true, proxy: 'http://127.0.0.1:7890' };
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token;
const metrics = [];
const headers = () => (token ? { Authorization: `Bearer ${token}` } : {});
const post = async (path, data) => {
  const response = await curlRequest(base + path, {
    ...transport,
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(data)),
  });
  metrics.push({ path, ...response.metrics });
  assert.equal(response.metrics.errorCode, null);
  return new Response(response.bytes?.length ? response.bytes : null, {
    status: response.metrics.status,
  });
};
let complete = false,
  failure = null,
  logout = null;
try {
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const bytes = await readFile('tests/fixtures/small.png');
  const form = await encodedUpload({ name: 'bulk-recovery-existing', bytes });
  const measured = await retryCurlUpload(base + '/api/assets', {
    ...transport,
    headers: {
      ...headers(),
      'Content-Type': form.type,
      'x-immich-checksum': createHash('sha1').update(bytes).digest('hex'),
    },
    body: form.bytes,
    onAttempt: async (entry) => metrics.push({ path: '/api/assets', ...entry }),
  });
  assert.equal(measured.metrics.errorCode, null);
  const uploaded = new Response(measured.bytes, { status: measured.metrics.status });
  assert.ok([200, 201].includes(uploaded.status));
  const { id } = await uploaded.json();
  const checksum = createHash('sha1').update(bytes).digest('base64');
  const checked = await post('/api/assets/bulk-upload-check', {
    assets: [
      { id: 'first', checksum },
      { id: 'second', checksum },
      { id: 'new', checksum: '0'.repeat(40) },
    ],
  });
  assert.equal(checked.status, 200);
  assert.deepEqual((await checked.json()).results, [
    { id: 'first', action: 'reject', reason: 'duplicate', assetId: id, isTrashed: false },
    { id: 'second', action: 'reject', reason: 'duplicate', assetId: id, isTrashed: false },
    { id: 'new', action: 'accept' },
  ]);
  const original = await readCurlRanges(`${base}/api/assets/${id}/original`, {
    ...transport,
    headers: headers(),
    expected: bytes,
    onAttempt: async (entry) => metrics.push({ path: '/api/assets/original', ...entry }),
  });
  assert.equal(original.metrics.errorCode, null);
  assert.deepEqual(original.bytes, bytes);
  const stream = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(stream.status, 200);
  const events = (await stream.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === id));
  assert.equal((await post('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  logout = (await post('/api/auth/logout', {})).status;
  assert.equal(logout, 200);
  token = undefined;
  complete = true;
} catch {
  failure = 'PROBE_FAILED';
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      logout = (await post('/api/auth/logout', {})).status;
    } catch {
      logout = 'unconfirmed';
    }
  }
  await writeFile(
    'work/bulk-recovery-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        complete,
        failure,
        logout,
        metrics,
        existingDuplicate: complete,
        unknownAccepted: complete,
        originalBytesMatch: complete,
        syncAndAck: complete,
        remoteStorageFaultInjected: false,
        officialAppVerified: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ complete, failure, logout }));
}
