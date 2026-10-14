import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = 'https://immich-cf-api-dev.fun.workers.dev';
const account = JSON.parse(await readFile('work/dev-account.json', 'utf8'));
let token;
try {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  assert.equal(login.status, 201);
  token = (await login.json()).accessToken;
  const png = await readFile('tests/fixtures/small.png');
  const broken = Buffer.from(png);
  broken[29] ^= 1;
  const results = [];
  for (const [name, bytes, expected] of [
    ['corrupt-png-crc', broken, 400],
    ['over-limit', Buffer.alloc(2 * 1024 * 1024 + 1), 413],
  ]) {
    const form = new FormData();
    form.set('assetData', new File([bytes], 'validation.png'));
    form.set('fileCreatedAt', '2026-10-15T00:00:00Z');
    form.set('fileModifiedAt', '2026-10-15T00:00:00Z');
    const response = await fetch(`${base}/api/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(response.status, expected);
    const error = await response.json();
    assert.match(JSON.stringify(error), /assetData/);
    if (name === 'corrupt-png-crc') assert.match(JSON.stringify(error), /校验和/);
    results.push({ name, status: response.status, fieldIdentified: true });
  }
  const sync = await fetch(`${base}/api/sync/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ types: ['UsersV1', 'AssetsV2'] }),
  });
  assert.equal(sync.status, 200);
  assert.equal(JSON.parse((await sync.text()).trim().split('\n').at(-1)).type, 'SyncCompleteV1');
  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(logout.status, 200);
  token = undefined;
  await writeFile(
    'work/upload-validation-probe.json',
    JSON.stringify(
      { checkedAt: new Date().toISOString(), results, syncComplete: true, logout: 200 },
      null,
      2,
    ),
  );
  console.log('dev upload validation passed; sanitized report saved');
} finally {
  if (token)
    await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
}
