import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
import { appleExif, withXmp } from '../tests/fixtures/live-photo-exif.mjs';
import { withExif } from '../tests/fixtures/exif.mjs';
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
try {
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const jpg = await readFile('tests/fixtures/small.jpg'),
    png = await readFile('tests/fixtures/small.png');
  // Readiness check: the deliberately wrong checksum prevents an older Worker
  // from publishing this fixture while a new deployment is propagating.
  const readiness = await encodedUpload({ name: 'readiness', bytes: withXmp(jpg) });
  const ready = await fetch(base + '/api/assets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': readiness.type,
      'x-immich-checksum': '0'.repeat(40),
    },
    body: readiness.bytes,
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(ready.status, 400);
  assert.match((await ready.json()).message, /XMP/);
  const bad = appleExif(1);
  bad.writeUInt32LE(0xffffffff, 36);
  const cases = [
    ['apple-jpeg', withExif(jpg, appleExif())],
    ['apple-png', withExif(png, appleExif(0x17, false, true), 'png')],
    ['malformed', withExif(jpg, bad)],
    ['xmp-jpeg', withXmp(jpg)],
    ['xmp-png', withXmp(png, 'png')],
  ];
  const results = [];
  for (const [name, bytes] of cases) {
    // Deliberately no motion request, device fields or livePhotoVideoId.
    const encoded = await encodedUpload({ name, bytes });
    const r = await fetch(base + '/api/assets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': encoded.type },
      body: encoded.bytes,
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(r.status, 400, name);
    assert.deepEqual((await r.json()).errors[0].path, ['assetData']);
    results.push({ name, status: r.status });
  }
  const encoded = await encodedUpload({ name: 'plain', bytes: png });
  const r = await fetch(base + '/api/assets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': encoded.type },
    body: encoded.bytes,
    signal: AbortSignal.timeout(30000),
  });
  assert.ok([200, 201].includes(r.status));
  const id = (await r.json()).id;
  const sync = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(sync.status, 200);
  const events = (await sync.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === id));
  assert.equal((await post('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  assert.equal((await post('/api/auth/logout', {})).status, 200);
  token = undefined;
  await writeFile(
    'work/live-photo-metadata-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        results,
        standaloneStatus: r.status,
        syncAndAck: true,
        officialAppVerified: false,
        realLivePhotoFixtureVerified: false,
      },
      null,
      2,
    ),
  );
  console.log('dev metadata guard passed without prior motion or device identifiers');
} finally {
  if (token) await post('/api/auth/logout', {});
}
