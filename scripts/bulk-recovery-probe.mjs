import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token;
const request = (path, options = {}) =>
  fetch(base + path, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    signal: AbortSignal.timeout(30000),
  });
const post = (path, data) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
try {
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const bytes = await readFile('tests/fixtures/small.png');
  const form = await encodedUpload({ name: 'bulk-recovery-existing', bytes });
  const uploaded = await request('/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': form.type },
    body: form.bytes,
  });
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
  const original = await request(`/api/assets/${id}/original`);
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  const stream = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(stream.status, 200);
  const events = (await stream.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === id));
  assert.equal((await post('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  assert.equal((await post('/api/auth/logout', {})).status, 200);
  token = undefined;
  await writeFile(
    'work/bulk-recovery-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        existingDuplicate: true,
        unknownAccepted: true,
        originalBytesMatch: true,
        syncAndAck: true,
        remoteStorageFaultInjected: false,
        officialAppVerified: false,
      },
      null,
      2,
    ),
  );
  console.log('dev bulk precheck probe passed');
} finally {
  if (token) await post('/api/auth/logout', {});
}
