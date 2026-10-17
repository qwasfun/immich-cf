import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { largePng } from '../tests/fixtures/large-images.mjs';
import { encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
import { withExif } from '../tests/fixtures/exif.mjs';
import { appleExif } from '../tests/fixtures/live-photo-exif.mjs';
import { curlRequest } from './lib/curl-request.mjs';
import { retryCurlUpload, readCurlRanges } from './lib/curl-recovery.mjs';
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const network = { proxy: 'http://127.0.0.1:7890', tls12: true };
const report = {
  checkedAt: new Date().toISOString(),
  complete: false,
  failure: null,
  logout: null,
  results: [],
  metrics: [],
  sync: null,
  privateSamplesUploaded: false,
  productionFaultInjection: false,
  officialAppVerified: false,
  cpuGatePassed: false,
};
const save = () =>
  writeFile('work/large-pixel-recovery-dev-probe.json', JSON.stringify(report, null, 2));
let token,
  phase = 'login';
const savedIds = [];
const headers = () => (token ? { Authorization: `Bearer ${token}` } : {});
const transient = (r) =>
  ['CURL_18', 'CURL_28', 'CURL_52', 'CURL_55', 'CURL_56'].includes(r.metrics.errorCode) ||
  (r.metrics.errorCode === 'CURL_35' && r.metrics.uploadedBytes === 0) ||
  (!r.metrics.errorCode && [502, 503, 504].includes(r.metrics.status));
async function json(path, data) {
  const deadline = performance.now() + 60000;
  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 100) break;
    response = await curlRequest(base + path, {
      ...network,
      timeoutMs: Math.min(20000, remaining),
      maxResponseBytes: 1048576,
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(data)),
    });
    report.metrics.push({ path, attempt, ...response.metrics });
    await save();
    if (!transient(response)) break;
  }
  assert.ok(response && !response.metrics.errorCode, 'JSON bounded transport failed');
  return response;
}
function paddedPng(source, size) {
  const chunk = Buffer.alloc(size - source.length, 97);
  chunk.writeUInt32BE(chunk.length - 12);
  chunk.write('tEXt', 4);
  chunk.write('Comment\0', 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([source.subarray(0, -12), chunk, source.subarray(-12)]);
}
async function upload(name, bytes, truncate = false) {
  const encoded = await encodedUpload({ name, bytes });
  const result = await retryCurlUpload(base + '/api/assets', {
    ...network,
    headers: {
      ...headers(),
      'Content-Type': encoded.type,
      'x-immich-checksum': createHash('sha1').update(bytes).digest('hex'),
    },
    body: truncate ? encoded.bytes.subarray(0, encoded.bytes.length - 24) : encoded.bytes,
    onAttempt: async (m) => {
      report.metrics.push({ path: '/api/assets', case: name, ...m });
      await save();
    },
  });
  assert.equal(result.metrics.errorCode, null, 'Upload bounded transport failed');
  return { status: result.metrics.status, value: JSON.parse(result.bytes) };
}
try {
  const account = JSON.parse(await readFile('work/dev-pixel-account.json', 'utf8'));
  const login = await json('/api/auth/login', { email: account.email, password: account.password });
  assert.equal(login.metrics.status, 201);
  token = JSON.parse(login.bytes).accessToken;
  const bytes = await largePng();
  for (const item of [
    { name: 'truncated-48mp', bytes, truncate: true, expected: 400 },
    { name: 'live-photo-48mp', bytes: withExif(bytes, appleExif(0x11), 'png'), expected: 400 },
    { name: 'over-4MiB-48mp', bytes: paddedPng(bytes, 4194305), expected: 413 },
    { name: 'recovered-48mp', bytes },
    { name: 'at-4MiB-decodable-48mp', bytes: paddedPng(bytes, 4194304) },
  ]) {
    phase = item.name;
    const result = await upload(item.name, item.bytes, item.truncate);
    if (item.expected) {
      assert.equal(result.status, item.expected);
      assert.deepEqual(result.value.errors[0].path, ['assetData']);
      report.results.push({
        name: item.name,
        status: result.status,
        bytes: item.bytes.length,
        passed: true,
      });
    } else {
      assert.ok(
        [200, 201].includes(result.status),
        'Supported upload rejected; check account quota',
      );
      const duplicate = await upload(item.name, item.bytes);
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.value.id, result.value.id);
      for (const suffix of ['original', 'thumbnail?size=preview']) {
        const media = await readCurlRanges(`${base}/api/assets/${result.value.id}/${suffix}`, {
          ...network,
          headers: headers(),
          expected: item.bytes,
          onAttempt: async (m) => {
            report.metrics.push({ path: '/api/assets/{id}/media', case: item.name, ...m });
            await save();
          },
        });
        assert.equal(media.metrics.errorCode, null);
        assert.ok(media.bytes.equals(item.bytes));
      }
      // Keep asset identities only in memory; exported results use fixed aliases.
      item.id = result.value.id;
      report.results.push({
        name: item.name,
        status: result.status,
        bytes: item.bytes.length,
        width: 8064,
        height: 6048,
        duplicateSameId: true,
        originalAndPreviewBytesMatch: true,
        passed: true,
      });
      savedIds.push(item.id);
    }
  }
  phase = 'reset-ack';
  const ids = savedIds;
  const stream = await json('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'], reset: true });
  assert.equal(stream.metrics.status, 200);
  const events = stream.bytes.toString().trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'SyncCompleteV1');
  for (const id of ids) {
    const matches = events.filter((e) => e.type === 'AssetV2' && e.data.id === id);
    assert.equal(matches.length, 1);
    assert.deepEqual([matches[0].data.width, matches[0].data.height], [8064, 6048]);
  }
  assert.equal(
    (await json('/api/sync/ack', { acks: events.map((e) => e.ack) })).metrics.status,
    204,
  );
  const incremental = await json('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] });
  assert.equal(incremental.metrics.status, 200);
  assert.ok(
    incremental.bytes
      .toString()
      .trim()
      .split('\n')
      .map(JSON.parse)
      .every((e) => e.type === 'SyncCompleteV1'),
  );
  report.sync = {
    resetTrue: true,
    savedAssetsFoundOnce: ids.length,
    dimensionsMatch: true,
    ack: 204,
    emptyIncremental: true,
  };
  report.complete = true;
} catch (error) {
  report.failure = {
    phase,
    message:
      error instanceof assert.AssertionError
        ? error.message
        : 'Probe setup or runtime failed; inspect local dependencies and account file',
  };
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      report.logout = (await json('/api/auth/logout', {})).metrics.status;
      assert.equal(report.logout, 200);
    } catch {
      report.logout = 'unconfirmed';
      report.complete = false;
      process.exitCode = 1;
    }
  }
  await save();
  console.log(
    JSON.stringify({
      complete: report.complete,
      failure: report.failure,
      cases: report.results.length,
      requests: report.metrics.length,
      logout: report.logout,
    }),
  );
}
