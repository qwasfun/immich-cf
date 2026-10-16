import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { jpegCases } from '../tests/fixtures/jpeg-structure.mjs';
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
const upload = async (item, headers = {}) => {
  const encoded = await encodedUpload(item);
  return request('/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': encoded.type, ...headers },
    body: encoded.bytes,
  });
};
try {
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const cases = await jpegCases();
  // Prevent an older Worker from publishing the readiness fixture during rollout.
  const ready = await upload(
    cases.find((x) => x.name === 'late-live-photo'),
    { 'x-immich-checksum': '0'.repeat(40) },
  );
  assert.equal(ready.status, 400);
  assert.deepEqual((await ready.json()).errors[0].path, ['assetData']);
  const results = [],
    saved = [];
  for (const item of cases) {
    const r = await upload(item);
    const data = await r.json();
    if (item.status === 400) {
      assert.equal(r.status, 400, item.name);
      assert.deepEqual(data.errors[0].path, ['assetData']);
    } else {
      assert.ok([200, 201].includes(r.status), item.name);
      saved.push(data.id);
      const original = await request(`/api/assets/${data.id}/original`);
      assert.equal(original.status, 200);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), item.bytes);
      assert.equal((await upload(item)).status, 200);
    }
    results.push({ name: item.name, status: r.status });
  }
  const stream = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(stream.status, 200);
  const events = (await stream.text()).trim().split('\n').map(JSON.parse);
  for (const id of saved) assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === id));
  assert.equal((await post('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  assert.equal((await post('/api/auth/logout', {})).status, 200);
  token = undefined;
  await writeFile(
    'work/jpeg-structure-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        results,
        originalBytesMatch: true,
        duplicates: true,
        syncAndAck: true,
        officialAppVerified: false,
      },
      null,
      2,
    ),
  );
  console.log('dev JPEG structure probe passed');
} finally {
  if (token) await post('/api/auth/logout', {});
}
