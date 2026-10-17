import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { curlRequest } from './lib/curl-request.mjs';
import { readCurlRanges } from './lib/curl-recovery.mjs';
const args = process.argv.slice(2);
assert.ok(
  args.every(
    (a, i) => a === '--apply' || a === '--limit' || (args[i - 1] === '--limit' && /^\d+$/.test(a)),
  ),
  'Use --apply and --limit 1..20',
);
const limit = Number(args[args.indexOf('--limit') + 1] ?? 1);
// No --limit means one asset; explicit larger batches remain sequential.
const max = args.includes('--limit') ? limit : 1;
assert.ok(Number.isInteger(max) && max >= 1 && max <= 20);
const apply = args.includes('--apply');
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const transport = { tls12: true, proxy: 'http://127.0.0.1:7890' };
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token,
  complete = false,
  failure = null,
  logout = null;
const metrics = [],
  results = [];
const report = () =>
  writeFile(
    'work/integrity-upgrade-probe.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        apply,
        max,
        complete,
        failure,
        logout,
        results,
        metrics,
        officialAppVerified: false,
        remoteFaultInjected: false,
      },
      null,
      2,
    ),
  );
const safePath = (path) => path.replace(/[a-f0-9-]{36}/gi, '{id}');
async function request(path, data, method = 'POST', retry = true) {
  const deadline = performance.now() + 60000;
  let r;
  for (let attempt = 1; attempt <= (retry ? 3 : 1); attempt++) {
    const left = Math.floor(deadline - performance.now());
    if (left < 100) break;
    r = await curlRequest(base + path, {
      ...transport,
      method,
      timeoutMs: Math.min(left, 20000),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: Buffer.from(JSON.stringify(data)) } : {}),
    });
    metrics.push({ path: safePath(path), attempt, ...r.metrics });
    const retryable =
      ['CURL_18', 'CURL_28', 'CURL_52', 'CURL_55', 'CURL_56'].includes(r.metrics.errorCode) ||
      (r.metrics.errorCode === 'CURL_35' && r.metrics.uploadedBytes === 0) ||
      (!r.metrics.errorCode && [502, 503, 504].includes(r.metrics.status));
    await report();
    if (!retryable) break;
  }
  assert.ok(r);
  assert.equal(r.metrics.errorCode, null);
  return r;
}
async function json(path, data, retry = true) {
  const r = await request(path, data, 'POST', retry);
  assert.ok([200, 201].includes(r.metrics.status));
  return JSON.parse(r.bytes);
}
try {
  token = (
    await json('/api/auth/login', { email: account.email, password: account.password }, false)
  ).accessToken;
  const candidates = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const audit = await json('/api/immich-cf/storage-audit', after ? { after } : {});
    candidates.push(...audit.entries.filter((e) => e.kind === 'asset' && !e.checksumRequired));
    if (!audit.nextAfter) break;
    assert.ok(page < 9, 'Audit page limit');
    after = audit.nextAfter;
  }
  const sync = await request('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(sync.metrics.status, 200);
  const events = sync.bytes.toString().trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'SyncCompleteV1');
  const assets = new Map(
    events.filter((e) => e.type === 'AssetV2').map((e) => [e.data.id, e.data]),
  );
  const ack = await request('/api/sync/ack', { acks: events.map((e) => e.ack) });
  assert.equal(ack.metrics.status, 204);
  for (const candidate of candidates.slice(0, max)) {
    const asset = assets.get(candidate.id);
    assert.ok(asset);
    const path = `/api/assets/${candidate.id}/original`;
    const original = await request(path, undefined, 'GET');
    assert.equal(original.metrics.status, 200);
    assert.equal(createHash('sha1').update(original.bytes).digest('base64'), asset.checksum);
    const preview = await json('/api/immich-cf/upgrade-integrity', { id: candidate.id });
    assert.ok(preview.sourceBytesVerified || preview.alreadyVerified);
    let upgraded = false;
    if (apply) {
      const applied = await json('/api/immich-cf/upgrade-integrity', {
        id: candidate.id,
        apply: true,
      });
      assert.ok(applied.applied || applied.alreadyVerified);
      assert.equal(applied.originalRetained, true);
      const repeated = await json('/api/immich-cf/upgrade-integrity', {
        id: candidate.id,
        apply: true,
      });
      assert.equal(repeated.alreadyVerified, true);
      upgraded = true;
    }
    const read = await readCurlRanges(base + path, {
      ...transport,
      headers: { Authorization: `Bearer ${token}` },
      expected: original.bytes,
      onAttempt: async (entry) => metrics.push({ path: '/api/assets/{id}/original', ...entry }),
    });
    assert.equal(read.metrics.errorCode, null);
    assert.deepEqual(read.bytes, original.bytes);
    results.push({
      index: results.length,
      bytes: original.bytes.length,
      preflight: true,
      upgraded,
      originalBytesMatch: true,
      idempotent: upgraded,
    });
    await report();
  }
  if (apply && candidates.length) {
    // Audit per-ID through its bounded pages; do not export IDs, paths, filenames or hashes.
    const checked = new Set(candidates.slice(0, max).map((e) => e.id));
    after = undefined;
    for (let page = 0; page < 10; page++) {
      const audit = await json('/api/immich-cf/storage-audit', after ? { after } : {});
      for (const e of audit.entries)
        if (e.kind === 'asset' && checked.has(e.id)) {
          assert.equal(e.objectStatus, 'verified');
          assert.equal(e.checksumRequired, true);
          checked.delete(e.id);
        }
      if (!audit.nextAfter) break;
      assert.ok(page < 9);
      after = audit.nextAfter;
    }
    assert.equal(checked.size, 0);
  }
  const incremental = await request('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(incremental.metrics.status, 200);
  assert.deepEqual(
    incremental.bytes
      .toString()
      .trim()
      .split('\n')
      .map(JSON.parse)
      .map((e) => e.type),
    ['SyncCompleteV1'],
  );
  complete = true;
} catch {
  failure = 'PROBE_FAILED';
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      logout = (await request('/api/auth/logout', {})).metrics.status;
    } catch {
      logout = 'unconfirmed';
    }
  }
  if (logout !== 200) {
    complete = false;
    failure ??= 'LOGOUT_UNCONFIRMED';
    process.exitCode = 1;
  }
  await report();
  console.log(JSON.stringify({ complete, failure, logout, apply, processed: results.length }));
}
