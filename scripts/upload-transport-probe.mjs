import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { measuredRequest } from './lib/measured-request.mjs';
import { mixedCases, encodedUpload } from '../tests/fixtures/mixed-queue.mjs';
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
const report = {
  checkedAt: new Date().toISOString(),
  transport: 'node:https direct, explicit Content-Length, no connection reuse',
  timeoutMs: 45000,
  results: [],
  logout: null,
  officialAppVerified: false,
};
let token;
const save = () => writeFile('work/upload-transport-probe.json', JSON.stringify(report, null, 2));
try {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  for (const item of (await mixedCases()).filter((x) =>
    ['small-png', 'below-limit', 'at-limit', 'over-limit'].includes(x.name),
  )) {
    const encoded = await encodedUpload(item);
    console.log(`Checking ${item.name}`);
    const result = await measuredRequest(base + '/api/assets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': encoded.type,
        'Content-Length': String(encoded.bytes.length),
      },
      body: encoded.bytes,
      timeoutMs: report.timeoutMs,
      maxResponseBytes: 65536,
    });
    let accepted = false;
    if (!result.metrics.errorCode) {
      try {
        const data = JSON.parse(result.bytes.toString());
        accepted =
          item.status === 413
            ? result.metrics.status === 413 && data.errors?.[0]?.path?.[0] === 'assetData'
            : [200, 201].includes(result.metrics.status) && typeof data.id === 'string';
      } catch {
        /* Non-JSON responses are not successful contract validation. */
      }
    }
    report.results.push({
      name: item.name,
      fileBytes: item.bytes.length,
      requestBytes: encoded.bytes.length,
      ...result.metrics,
      contractPassed: accepted,
    });
    await save();
    console.log(JSON.stringify(report.results.at(-1)));
  }
} finally {
  if (token) {
    try {
      const r = await fetch(base + '/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(30000),
      });
      report.logout = r.status;
    } catch {
      report.logout = 'unconfirmed';
    }
  }
  await save();
}
if (!report.results.length || report.results.some((x) => !x.contractPassed)) process.exitCode = 1;
