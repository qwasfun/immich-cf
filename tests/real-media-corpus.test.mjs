import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { loadCorpus, readSample, corpusSummary } from '../scripts/lib/real-media-corpus.mjs';
import { localCorpusTransport } from '../scripts/lib/real-media-runner.mjs';
const sample = (file = 'private-file.png') => ({
  file,
  provenance: 'synthetic-fixture',
  captureId: 'synthetic-1',
  expected: { status: 201, mime: 'image/png', width: 320, height: 240 },
});
async function fixture(samples = [sample()]) {
  const root = path.resolve('work', `corpus-unit-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'private-file.png'), await readFile('tests/fixtures/small.png'));
  const manifest = path.join(root, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ version: 1, samples }));
  return { root, manifest };
}
test('真实样本清单限制范围、来源声明、独立期望与文件变化，错误不回显私人路径', async () => {
  const { manifest, root } = await fixture();
  const entries = await loadCorpus(manifest);
  assert.equal(entries.length, 1);
  assert.ok((await readSample(entries[0])).length > 0);
  const cases = [
    { ...sample(), file: '../private-file.png' },
    { ...sample(), file: 'C:/private.png' },
    { ...sample(), file: 'private-file.png:secret' },
    { ...sample(), provenance: 'real-ish' },
    { ...sample(), captureId: 'private@email.invalid' },
    { ...sample(), expected: { status: 201, mime: 'image/png' } },
  ];
  for (const s of cases) {
    await writeFile(manifest, JSON.stringify({ version: 1, samples: [s] }));
    await assert.rejects(
      loadCorpus(manifest),
      (e) =>
        e.field?.startsWith('samples.0') &&
        !e.message.includes(s.file) &&
        !e.message.includes('private@email'),
    );
  }
  await writeFile(path.join(root, 'private-file.png'), Buffer.alloc(entries[0].size, 1));
  await assert.rejects(readSample(entries[0]), /样本已改变/);
});
test('清单链接不能逃出样本目录，且不接受目录作为样本', async () => {
  const a = await fixture(),
    b = await fixture();
  await symlink(b.root, path.join(a.root, 'link'), 'junction');
  for (const file of ['link/private-file.png', 'link']) {
    await writeFile(a.manifest, JSON.stringify({ version: 1, samples: [sample(file)] }));
    await assert.rejects(loadCorpus(a.manifest), (e) => e.field === 'samples.0.file');
  }
});

test('大像素清单与服务端共用上限，独立布局尺寸仍须校验且允许声明超限拒绝', async () => {
  const { manifest } = await fixture();
  const entry = sample();
  for (const [width, height] of [
    [8064, 6048],
    [8192, 6144],
    [8000, 8000],
    [16384, 1],
  ]) {
    entry.expected = { status: 201, mime: 'image/png', width, height };
    await writeFile(manifest, JSON.stringify({ version: 1, samples: [entry] }));
    assert.equal((await loadCorpus(manifest)).length, 1);
  }
  for (const [width, height] of [
    [16385, 1],
    [1, 16385],
    [8000, 8001],
    [0, 200],
    [1.5, 200],
  ]) {
    entry.expected = { status: 201, mime: 'image/png', width, height };
    await writeFile(manifest, JSON.stringify({ version: 1, samples: [entry] }));
    await assert.rejects(loadCorpus(manifest), (e) => e.field.startsWith('samples.0.expected.'));
  }
  entry.expected = { status: 400, mime: 'image/png' };
  await writeFile(manifest, JSON.stringify({ version: 1, samples: [entry] }));
  assert.equal((await loadCorpus(manifest)).length, 1);
});
test('100个合成/重复内容或同次拍摄变体不能计为100个独立真实样本', () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    index,
    sha256: `hash-${index}`,
    captureId: `capture-${index}`,
    provenance: 'synthetic-fixture',
    expected: { mime: index % 2 ? 'image/jpeg' : 'image/png' },
  }));
  const results = entries.map((e) => ({ index: e.index, accepted: true, passed: true }));
  assert.equal(corpusSummary(entries, results).declaredRealThresholdMet, false);
  const real = entries.map((e) => ({ ...e, provenance: 'user-original' }));
  assert.equal(
    corpusSummary(
      real.map((e) => ({ ...e, sha256: 'same' })),
      results,
    ).declaredRealThresholdMet,
    false,
  );
  assert.equal(
    corpusSummary(
      real.map((e) => ({ ...e, captureId: 'same' })),
      results,
    ).declaredRealThresholdMet,
    false,
  );
  const summary = corpusSummary(real, results);
  assert.equal(summary.declaredRealThresholdMet, true);
  assert.equal(summary.provenanceIndependentlyVerified, false);
  assert.equal(summary.g1Passed, false);
  assert.equal(corpusSummary(real, []).declaredRealThresholdMet, false);
  assert.equal(JSON.stringify(summary).includes('hash-'), false);
});
test('真实样本传输层拒绝公网、凭据、重定向路径和非固定回环地址', () => {
  for (const base of [
    'https://immich-cf-api-dev.fun.workers.dev',
    'http://example.invalid:80',
    'http://localhost:1234',
    'http://x:secret@127.0.0.1:1234',
    'http://127.0.0.1:1234/path',
    'http://127.0.0.1:1234/?q=1',
  ])
    assert.throws(() => localCorpusTransport(base), /server/);
  assert.ok(localCorpusTransport('http://127.0.0.1:1234'));
});

test('样本验收保留服务端具体字段原因，即使退出失败也不覆盖原错误', async () => {
  const { verifyCorpus } = await import('../scripts/lib/real-media-runner.mjs');
  const { manifest } = await fixture();
  const entries = await loadCorpus(manifest);
  const transport = {
    upload: async () => ({
      status: 400,
      bytes: Buffer.from(JSON.stringify({ message: 'assetData：文件校验不符，请保留原件后重试' })),
    }),
    json: async () => {
      throw new Error('cleanup unavailable');
    },
  };
  await assert.rejects(
    verifyCorpus(entries, { transport, account: async () => 'not-exported-token' }),
    (e) =>
      e.field === 'samples.0.expected.status' &&
      e.message.includes('assetData：文件校验不符') &&
      e.cleanupUnconfirmed &&
      !e.message.includes('not-exported-token'),
  );
});
