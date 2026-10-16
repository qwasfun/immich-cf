import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mixedCases, encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
import { curlRequest } from './lib/curl-request.mjs';
const useCurl = process.argv.includes('--curl');
const uploadMetrics = [];
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token;
const headers = () => (token ? { Authorization: `Bearer ${token}` } : {});
const post = (path, data) =>
  fetch(base + path, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30000),
  });
try {
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const cases = await mixedCases();
  const results = [];
  const saved = [];
  // Deterministic files: reruns deduplicate; at most four logical test images.
  for (const item of cases) {
    const encoded = await encodedUpload(item);
    console.log(`Checking ${item.name}`);
    let response;
    if (useCurl) {
      const measured = await curlRequest(base + '/api/assets', {
        headers: { ...headers(), 'Content-Type': encoded.type },
        body: encoded.bytes,
      });
      uploadMetrics.push({
        name: item.name,
        requestBytes: encoded.bytes.length,
        ...measured.metrics,
      });
      await writeFile(
        'work/mixed-queue-curl-progress.json',
        JSON.stringify(
          { checkedAt: new Date().toISOString(), uploadMetrics, complete: false },
          null,
          2,
        ),
      );
      assert.equal(measured.metrics.errorCode, null, item.name);
      response = new Response(measured.bytes, { status: measured.metrics.status });
    } else
      response = await fetch(base + '/api/assets', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': encoded.type },
        body: encoded.bytes,
        signal: AbortSignal.timeout(30000),
      });
    const result = await response.json();
    if (item.field) {
      assert.equal(response.status, item.status, item.name);
      assert.deepEqual(result.errors[0].path, [item.field]);
    } else {
      assert.ok([200, 201].includes(response.status), item.name);
      saved.push({ id: result.id, bytes: item.bytes });
    }
    results.push({ name: item.name, status: response.status, field: item.field ?? null });
  }
  for (const asset of saved) {
    const response = await fetch(`${base}/api/assets/${asset.id}/original`, {
      headers: headers(),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.bytes);
  }
  const response = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  for (const asset of saved)
    assert.ok(events.some((e) => e.type === 'AssetV2' && e.data.id === asset.id));
  assert.equal((await post('/api/sync/ack', { acks: events.map((e) => e.ack) })).status, 204);
  const incremental = await post('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.deepEqual(
    (await incremental.text())
      .trim()
      .split('\n')
      .map(JSON.parse)
      .map((e) => e.type),
    ['SyncCompleteV1'],
  );
  assert.equal((await post('/api/auth/logout', {})).status, 200);
  token = undefined;
  await writeFile(
    'work/mixed-queue-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        transport: useCurl ? 'curl HTTP1.1' : 'fetch',
        uploadTimeoutMs: useCurl ? 120000 : 30000,
        uploadMetrics,
        results,
        originalBytesMatch: true,
        syncAndAck: true,
        incrementalEmpty: true,
        logout: 200,
        officialAppQueueVerified: false,
      },
      null,
      2,
    ),
  );
  console.log('dev mixed HTTP queue passed; official App scheduling remains unverified');
} finally {
  if (token) await post('/api/auth/logout', {});
}
