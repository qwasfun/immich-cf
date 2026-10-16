import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mixedCases, encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
import { curlRequest, validateLoopbackProxy } from './lib/curl-request.mjs';
import { retryCurlUpload, readCurlRanges } from './lib/curl-recovery.mjs';
import { createHash } from 'node:crypto';
const useCurl = process.argv.includes('--curl');
const tls12 = process.argv.includes('--tls12');
const recover = process.argv.includes('--recover');
const proxyIndex = process.argv.indexOf('--proxy');
const proxy = proxyIndex < 0 ? undefined : process.argv[proxyIndex + 1];
if (proxyIndex >= 0 && (!useCurl || !proxy || proxy.startsWith('--')))
  throw new Error('--proxy requires --curl and a loopback HTTP proxy URL');
if (proxy !== undefined) validateLoopbackProxy(proxy);
if (recover && !useCurl) throw new Error('--recover requires --curl');
if (tls12 && !useCurl) throw new Error('--tls12 requires --curl');
const uploadMetrics = [];
const readMetrics = [];
const results = [];
let phase = 'login',
  complete = false,
  failure = null,
  logout = null;
const saveProgress = () =>
  writeFile(
    `work/mixed-queue-${useCurl ? 'curl-' : ''}progress.json`,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        transport: useCurl ? 'curl HTTP1.1' : 'fetch',
        tlsPolicy: useCurl ? (tls12 ? 'TLS1.2-only' : 'system-default') : 'fetch-default',
        recoveryEnabled: recover,
        proxyRequested: Boolean(proxy),
        phase,
        uploadMetrics,
        readMetrics,
        results,
        complete,
        failure,
        logout,
      },
      null,
      2,
    ),
  );
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
  await saveProgress();
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const cases = await mixedCases();
  const saved = [];
  // Deterministic files: reruns deduplicate; at most four logical test images.
  for (const item of cases) {
    phase = `upload:${item.name}`;
    await saveProgress();
    const encoded = await encodedUpload(item);
    console.log(`Checking ${item.name}`);
    let response;
    if (useCurl) {
      const measured = await (recover ? retryCurlUpload : curlRequest)(base + '/api/assets', {
        tls12,
        proxy,
        headers: {
          ...headers(),
          'Content-Type': encoded.type,
          ...(recover
            ? { 'x-immich-checksum': createHash('sha1').update(item.bytes).digest('hex') }
            : {}),
        },
        body: encoded.bytes,
        ...(recover
          ? {
              onAttempt: async (entry) => {
                uploadMetrics.push({
                  name: item.name,
                  requestBytes: encoded.bytes.length,
                  ...entry,
                });
                await saveProgress();
              },
            }
          : {}),
      });
      if (!recover)
        uploadMetrics.push({
          name: item.name,
          requestBytes: encoded.bytes.length,
          ...measured.metrics,
        });
      await saveProgress();
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
    await saveProgress();
  }
  for (const asset of saved) {
    phase = 'original-bytes';
    await saveProgress();
    let response;
    if (useCurl) {
      const measured = await (recover ? readCurlRanges : curlRequest)(
        `${base}/api/assets/${asset.id}/original`,
        {
          tls12,
          proxy,
          method: 'GET',
          headers: headers(),
          maxResponseBytes: 8 * 1024 * 1024,
          ...(recover
            ? {
                expected: asset.bytes,
                onAttempt: async (entry) => {
                  readMetrics.push({ expectedBytes: asset.bytes.length, ...entry });
                  await saveProgress();
                },
              }
            : {}),
        },
      );
      if (!recover) readMetrics.push({ expectedBytes: asset.bytes.length, ...measured.metrics });
      await saveProgress();
      assert.equal(measured.metrics.errorCode, null, 'original-bytes');
      response = new Response(measured.bytes, { status: measured.metrics.status });
    } else
      response = await fetch(`${base}/api/assets/${asset.id}/original`, {
        headers: headers(),
        signal: AbortSignal.timeout(30000),
      });
    assert.equal(response.status, recover ? 206 : 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.bytes);
  }
  phase = 'sync-and-ack';
  await saveProgress();
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
  phase = 'logout';
  logout = (await post('/api/auth/logout', {})).status;
  assert.equal(logout, 200);
  token = undefined;
  complete = true;
  phase = 'complete';
  await writeFile(
    'work/mixed-queue-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        transport: useCurl ? 'curl HTTP1.1' : 'fetch',
        tlsPolicy: useCurl ? (tls12 ? 'TLS1.2-only' : 'system-default') : 'fetch-default',
        recoveryEnabled: recover,
        proxyRequested: Boolean(proxy),
        uploadTimeoutMs: useCurl ? 120000 : 30000,
        uploadMetrics,
        readMetrics,
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
} catch (error) {
  failure = {
    phase,
    kind: ['AssertionError', 'TimeoutError', 'TypeError'].includes(error.name)
      ? error.name
      : 'ProbeError',
  };
  throw error;
} finally {
  if (token) {
    try {
      logout = (await post('/api/auth/logout', {})).status;
    } catch {
      logout = 'unconfirmed';
    }
  }
  await saveProgress();
}
