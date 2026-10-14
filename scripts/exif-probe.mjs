import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tiff, withExif } from '../tests/fixtures/exif.mjs';
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token;
const headers = () => ({ Authorization: `Bearer ${token}` });
const json = (path, data) =>
  fetch(base + path, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30000),
  });
try {
  const login = await json('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const image = await readFile('tests/fixtures/small.png');
  const bytes = withExif(image, tiff(6), 'png');
  const form = new FormData();
  form.set('assetData', new File([bytes], 'immich-cf-exif-6.png'));
  form.set('fileCreatedAt', '2026-10-15T00:00:00Z');
  form.set('fileModifiedAt', '2026-10-15T00:00:00Z');
  const uploaded = await fetch(base + '/api/assets', {
    method: 'POST',
    headers: headers(),
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  assert.ok([200, 201].includes(uploaded.status));
  const asset = await uploaded.json();
  const info = await (await fetch(`${base}/api/assets/${asset.id}`, { headers: headers() })).json();
  assert.deepEqual([info.width, info.height], [240, 320]);
  for (const kind of ['original', 'thumbnail?size=preview']) {
    const response = await fetch(`${base}/api/assets/${asset.id}/${kind}`, { headers: headers() });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  const stream = await json('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'], reset: true });
  assert.equal(stream.status, 200);
  const events = (await stream.text()).trim().split('\n').map(JSON.parse);
  const event = events.find((e) => e.type === 'AssetV2' && e.data.id === asset.id);
  assert.deepEqual([event.data.width, event.data.height], [240, 320]);
  assert.equal((await json('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  assert.equal((await json('/api/auth/logout', {})).status, 200);
  token = undefined;
  await writeFile(
    'work/exif-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        orientation: 6,
        dimensions: [240, 320],
        originalAndPreviewBytesMatch: true,
        syncDimensionsMatch: true,
        ack: 204,
        logout: 200,
      },
      null,
      2,
    ),
  );
  console.log('dev EXIF metadata probe passed; iOS rendering remains unverified');
} finally {
  if (token) await json('/api/auth/logout', {});
}
