import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const apply = process.argv.includes('--apply');
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token;
const call = async (path, data) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response;
};
try {
  token = (
    await (
      await call('/api/auth/login', { email: account.email, password: account.password })
    ).json()
  ).accessToken;
  const events = (await (await call('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] })).text())
    .trim()
    .split('\n')
    .map(JSON.parse);
  const assets = events.filter((e) => e.type === 'AssetV2');
  assert.ok(assets.length <= 20);
  // ACK the pre-repair snapshot to prove updates exceed the old cursor.
  await call('/api/sync/ack', { acks: events.map((e) => e.ack) });
  const results = [];
  for (const asset of assets) {
    const preview = await (
      await call('/api/immich-cf/repair-dimensions', { id: asset.data.id })
    ).json();
    const result =
      apply && preview.changed
        ? await (
            await call('/api/immich-cf/repair-dimensions', { id: asset.data.id, apply: true })
          ).json()
        : preview;
    results.push(result);
  }
  const next = (await (await call('/api/sync/stream', { types: ['UsersV1', 'AssetsV2'] })).text())
    .trim()
    .split('\n')
    .map(JSON.parse);
  for (const result of results.filter((r) => r.applied)) {
    const event = next.find((e) => e.type === 'AssetV2' && e.data.id === result.id);
    assert.ok(event);
    assert.deepEqual([event.data.width, event.data.height], result.after);
    const retry = await (
      await call('/api/immich-cf/repair-dimensions', { id: result.id, apply: true })
    ).json();
    assert.equal(retry.changed, false);
  }
  await call('/api/sync/ack', { acks: next.map((e) => e.ack) });
  await call('/api/auth/logout', {});
  token = undefined;
  const report = {
    checkedAt: new Date().toISOString(),
    apply,
    checked: results.length,
    changed: results.filter((r) => r.changed).length,
    applied: results.filter((r) => r.applied).length,
    syncRoundTripVerified: true,
    repairedUpdateDeliveryVerified: results.some((r) => r.applied) ? true : null,
    logout: 200,
  };
  await writeFile('work/repair-dimensions-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (token) await call('/api/auth/logout', {});
}
