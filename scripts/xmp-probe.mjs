import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
import { withXmp, appleExif } from '../tests/fixtures/live-photo-exif.mjs';
import { withExif } from '../tests/fixtures/exif.mjs';
import { staticXmp } from '../tests/fixtures/static-xmp.mjs';
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token;
const post = (path, data) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30000),
  });
const upload = async (bytes, fields = {}) => {
  const encoded = await encodedUpload({ name: 'xmp-check', bytes, fields });
  return fetch(base + '/api/assets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': encoded.type },
    body: encoded.bytes,
    signal: AbortSignal.timeout(30000),
  });
};
try {
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const png = await readFile('tests/fixtures/small.png');
  for (const bytes of [
    withXmp(png, 'png', 'iTXt', staticXmp.replaceAll('UserComment', 'ContentIdentifier')),
    withExif(withXmp(png, 'png', 'iTXt', staticXmp), appleExif(), 'png'),
  ]) {
    const r = await upload(bytes);
    assert.equal(r.status, 400);
    assert.deepEqual((await r.json()).errors[0].path, ['assetData']);
  }
  const samples = [withXmp(png, 'png', 'iTXt', staticXmp)];
  if (process.argv.includes('--private'))
    samples.push(await readFile('tests/private-fixtures/xmp/IMG_0096.PNG'));
  const saved = [];
  for (const bytes of samples) {
    const r = await upload(bytes);
    assert.ok([200, 201].includes(r.status));
    const id = (await r.json()).id;
    saved.push(id);
    assert.equal((await upload(bytes)).status, 200);
    const original = await fetch(`${base}/api/assets/${id}/original`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  }
  const r = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(r.status, 200);
  const events = (await r.text()).trim().split('\n').map(JSON.parse);
  for (const id of saved) assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === id));
  assert.equal((await post('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  assert.equal((await post('/api/auth/logout', {})).status, 200);
  token = undefined;
  await writeFile(
    'work/xmp-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        samples: samples.length,
        privateSample: process.argv.includes('--private'),
        staticUpload: true,
        duplicate: true,
        originalBytesMatch: true,
        syncAndAck: true,
        unknownXmpRejected: true,
        applePairingRejected: true,
        officialAppVerified: false,
      },
      null,
      2,
    ),
  );
  console.log('dev XMP check passed');
} finally {
  if (token) await post('/api/auth/logout', {});
}
