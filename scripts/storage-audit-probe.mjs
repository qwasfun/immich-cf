import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { curlRequest } from './lib/curl-request.mjs';
const args = process.argv.slice(2);
assert.ok(
  args.length <= 1 && args.every((arg) => arg === '--verify-sources'),
  'Use --verify-sources or no arguments',
);
const verifySources = args.includes('--verify-sources');
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const transport = { tls12: true, proxy: 'http://127.0.0.1:7890' };
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token,
  logout = null,
  failure = null,
  complete = false;
const metrics = [],
  observations = [],
  pageCounts = [],
  sourceChecks = [];
async function post(path, data, retry = false) {
  const deadline = performance.now() + 60000;
  let result;
  for (let attempt = 1; attempt <= (retry ? 3 : 1); attempt++) {
    const left = Math.floor(deadline - performance.now());
    if (left < 100) break;
    result = await curlRequest(base + path, {
      ...transport,
      timeoutMs: Math.min(left, 20000),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: Buffer.from(JSON.stringify(data)),
    });
    metrics.push({ path, attempt, ...result.metrics });
    const retryable =
      ['CURL_18', 'CURL_28', 'CURL_52', 'CURL_55', 'CURL_56'].includes(result.metrics.errorCode) ||
      (result.metrics.errorCode === 'CURL_35' && result.metrics.uploadedBytes === 0) ||
      (!result.metrics.errorCode && [502, 503, 504].includes(result.metrics.status));
    if (!retryable) break;
  }
  assert.ok(result);
  assert.equal(result.metrics.errorCode, null);
  return new Response(result.bytes?.length ? result.bytes : null, {
    status: result.metrics.status,
  });
}
try {
  const login = await post('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  let after;
  const cursors = new Set();
  const references = new Set();
  const sources = [];
  for (let page = 0; page < 10; page++) {
    const response = await post('/api/immich-cf/storage-audit', after ? { after } : {}, true);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.observationOnly, true);
    assert.equal(data.snapshotConsistent, false);
    assert.ok(data.entries.length <= 20);
    pageCounts.push(data.entries.length);
    for (const entry of data.entries) {
      assert.ok(['asset', 'intent', 'source'].includes(entry.kind));
      const reference = `${entry.kind}:${entry.id}`;
      assert.equal(references.has(reference), false);
      references.add(reference);
      if (entry.kind === 'source') sources.push(entry.id);
      observations.push({
        kind: entry.kind,
        objectStatus: entry.objectStatus,
        ...(['asset', 'source'].includes(entry.kind)
          ? { checksumRequired: entry.checksumRequired }
          : {}),
        ...(entry.relation ? { relation: entry.relation } : {}),
      });
    }
    if (!data.nextAfter) {
      complete = true;
      break;
    }
    assert.equal(cursors.has(data.nextAfter), false);
    cursors.add(data.nextAfter);
    after = data.nextAfter;
  }
  assert.equal(complete, true);
  if (verifySources) {
    for (const id of sources) {
      const response = await post(
        '/api/immich-cf/upgrade-integrity',
        { id, verifySource: true },
        true,
      );
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.target, 'source');
      assert.equal(data.sourceBytesVerified, true);
      assert.equal(data.applied, false);
      assert.equal(data.observationOnly, true);
      assert.equal(data.snapshotConsistent, false);
      assert.ok(Number.isInteger(data.bytes) && data.bytes > 0 && data.bytes <= 4 * 1024 * 1024);
      sourceChecks.push({
        index: sourceChecks.length,
        bytes: data.bytes,
        sourceBytesVerified: true,
        checkedAt: new Date().toISOString(),
      });
    }
  }
} catch {
  complete = false;
  failure = 'PROBE_FAILED';
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      logout = (await post('/api/auth/logout', {}, true)).status;
    } catch {
      logout = 'unconfirmed';
    }
  }
  if (logout !== 200) {
    complete = false;
    failure ??= 'LOGOUT_UNCONFIRMED';
    process.exitCode = 1;
  }
  await writeFile(
    'work/storage-audit-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        complete,
        failure,
        logout,
        observations,
        pageCounts,
        verifySourcesRequested: verifySources,
        sourceChecks,
        metrics,
        scope: 'public-read-only-observations',
        remoteStorageFaultInjected: false,
        officialAppVerified: false,
        snapshotConsistent: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ complete, failure, logout, observed: observations.length }));
}
