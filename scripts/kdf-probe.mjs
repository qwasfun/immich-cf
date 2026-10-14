import { unstable_dev } from 'wrangler';
import { pbkdf2Sync, scryptSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const password = 'immich-cf-synthetic-kdf-fixture',
  salt = 'immich-cf-kdf-salt-16';
const worker = await unstable_dev('tests/fixtures/kdf-probe.ts', {
  config: 'wrangler.json',
  env: 'dev',
  local: true,
  ip: '127.0.0.1',
  port: 0,
  experimental: { disableExperimentalWarning: true, forceLocal: true, watch: false },
});
const samples = [];
try {
  for (const algorithm of ['pbkdf2-sha256-600000', 'scrypt-n32768-r8-p3']) {
    const response = await worker.fetch(`/${algorithm}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    if (result.supported) {
      const expected = algorithm.startsWith('pbkdf2')
        ? pbkdf2Sync(password, salt, 600000, 32, 'sha256')
        : scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
      assert.equal(result.hex, expected.toString('hex'));
    }
    samples.push({
      algorithm,
      supported: result.supported,
      vectorMatches: result.supported ? true : null,
      ...(!result.supported ? { reason: result.reason } : {}),
      remoteCpuMs: null,
    });
  }
  const report = {
    runtime: 'local workerd via project-pinned Wrangler',
    scope:
      'synthetic support and Node reference vector only; not production security approval or Free CPU validation',
    samples,
  };
  await writeFile('work/kdf-probe.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await worker.stop();
}
