import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token;
const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
const login = async () => {
  const r = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(r.status, 201);
  token = (await r.json()).accessToken;
};
const logout = async () => {
  assert.equal((await post('/api/auth/logout', {})).status, 200);
  token = undefined;
};
const bytes = await readFile('tests/fixtures/small.png');
const pair = { deviceId: 'immich-cf-live-photo-probe', deviceAssetId: 'synthetic-pair-1' };
const upload = async (fields) => {
  const encoded = await encodedUpload({ name: 'live-photo-probe', bytes, fields });
  return fetch(base + '/api/assets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': encoded.type },
    body: encoded.bytes,
    signal: AbortSignal.timeout(30000),
  });
};
try {
  await login();
  assert.equal((await upload({ ...pair, visibility: 'hidden' })).status, 400);
  await logout();
  await login();
  for (let i = 0; i < 2; i++) {
    const r = await upload(pair);
    assert.equal(r.status, 400);
    assert.deepEqual((await r.json()).errors[0].path, ['assetData']);
  }
  const normal = await upload({ ...pair, deviceAssetId: 'standalone' });
  assert.ok([200, 201].includes(normal.status));
  const id = (await normal.json()).id;
  const sync = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(sync.status, 200);
  const events = (await sync.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === id));
  assert.equal((await post('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  await logout();
  await writeFile(
    'work/live-photo-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        markedRejected: true,
        stillRejectedAfterRelogin: true,
        repeatedStillRejected: true,
        standaloneStatus: normal.status,
        syncAndAck: true,
        officialAppVerified: false,
      },
      null,
      2,
    ),
  );
  console.log('dev Live Photo identified-pair guard passed');
} finally {
  if (token) await logout();
}
