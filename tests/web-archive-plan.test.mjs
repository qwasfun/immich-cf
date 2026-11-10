import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url),
  { build } = createRequire(require.resolve('wrangler'))('esbuild');
const result = await build({
  entryPoints: [path.resolve('src/web/archive-plan.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { ArchivePlanner, ARCHIVE_BYTES, ARCHIVE_FILES, safeArchiveName } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);
const photo = (id, fields = {}) => ({
  id,
  filename: '照片.jpg',
  mime: 'image/jpeg',
  bytes: 10,
  modified: '2026-11-11T00:00:00.000Z',
  motionId: null,
  motionBytes: 0,
  ...fields,
});
test('ZIP 分包同时遵守字节和文件数上限，Live Photo 两份原件不会拆开', () => {
  const p = new ArchivePlanner();
  p.add(photo('first', { bytes: ARCHIVE_BYTES - 20 }));
  p.add(photo('live', { motionId: 'motion', motionBytes: 20 }));
  assert.equal(p.parts.length, 2);
  assert.deepEqual(
    p.parts[1].entries.map((x) => x.id),
    ['live', 'motion'],
  );
  const many = new ArchivePlanner();
  for (let i = 0; i < ARCHIVE_FILES - 1; i++) many.add(photo(String(i)));
  many.add(photo('live', { motionId: 'motion', motionBytes: 20 }));
  assert.equal(many.parts.length, 2);
  assert.equal(many.parts[0].entries.length, ARCHIVE_FILES - 1);
  assert.equal(many.parts[1].entries.length, 2);
});
test('中文、跨包重名、大小写和 Windows 特殊名称不会生成覆盖文件或路径穿越', () => {
  const p = new ArchivePlanner();
  p.add(
    photo('a', {
      filename: '旅行.HEIC',
      mime: 'image/heic',
      bytes: ARCHIVE_BYTES - 20,
      motionId: 'av',
      motionBytes: 10,
    }),
  );
  p.add(photo('b', { filename: '旅行.heic', mime: 'image/heic', motionId: 'bv', motionBytes: 10 }));
  assert.equal(p.parts.length, 2);
  assert.equal(p.parts[0].entries[0].name, '旅行.HEIC');
  assert.equal(p.parts[1].entries[0].name, '旅行 (2).heic');
  assert.equal(p.parts[1].entries[1].name, '旅行 (2).mov');
  for (const name of [
    '../CON.jpg',
    'NUL.jpg',
    'a\\b/恶意\u202e.jpg',
    '   ',
    '.'.repeat(20),
    '超'.repeat(255) + '.heic',
  ]) {
    const safe = safeArchiveName(name);
    assert.ok(safe.length);
    assert.doesNotMatch(safe, /[<>:"/\\|?*\x00-\x1f\u202a-\u202e]/);
    assert.ok(Buffer.byteLength(safe) <= 160);
    assert.ok(!/^(con|nul)(\.|$)/i.test(safe));
  }
});
