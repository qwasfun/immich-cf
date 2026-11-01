import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { exportAccount } from '../scripts/admin-export.mjs';

async function fixture(mode = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'immich-pages-')),
    out = join(root, 'export'),
    credentials = join(root, 'credentials.json'),
    owner = randomUUID();
  await writeFile(credentials, JSON.stringify({ accessToken: 'a'.repeat(64) }));
  const count = mode === 'large' ? 10001 : 121,
    albumCount = mode === 'large' ? 1 : 20;
  const assets = Array.from({ length: count }, (_, i) => {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
      bytes = Buffer.from('original-' + i);
    return {
      id,
      filename: 'original',
      mime: i === 50 ? 'video/quicktime' : i === 49 ? 'image/jpeg' : 'image/png',
      bytes: bytes.length,
      checksum: createHash('sha1').update(bytes).digest('base64'),
      sync_seq: i + 1,
      media_type: i === 50 ? 'VIDEO' : 'IMAGE',
      visibility: i === 50 ? 'hidden' : 'timeline',
      deleted_at: null,
      live_photo_video_id: null,
      downloadPath: `/api/immich-cf/admin/export/original?userId=${owner}&id=${id}&revision=${i + 1}`,
    };
  });
  assets[49].live_photo_video_id = assets[50].id;
  const albums = Array.from({ length: albumCount }, (_, i) => ({
    id: `10000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    name: 'album',
    thumbnail_asset_id: assets[49].id,
  }));
  const relations = albums.flatMap((album) =>
    assets
      .filter((a) => a.media_type === 'IMAGE')
      .map((a) => ({ album_id: album.id, asset_id: a.id })),
  );
  const totals = { assets: assets.length, albums: albums.length, relations: relations.length },
    snapshot = { assetRevision: 12345, albumRevision: 23456 },
    pages = [];
  for (const [kind, items, size] of [
    ['assets', assets, 50],
    ['albums', albums, 20],
    ['relations', relations, 2000],
  ])
    for (let at = 0; at < items.length; at += size)
      pages.push({ kind, items: items.slice(at, at + size) });
  pages.push({ kind: 'complete', items: [] });
  let terminalReads = 0,
    downloads = 0;
  const request = async (url, options) => {
    assert.equal(options.method, 'GET');
    const u = new URL(url);
    if (u.pathname.endsWith('/page')) {
      const cursor = u.searchParams.get('cursor'),
        n = cursor === null ? 0 : Number(cursor.slice(1));
      assert.ok(Number.isSafeInteger(n) && n >= 0 && n < pages.length);
      const data = {
        format: 'immich-cf-account-pages-v1',
        manifestFormat: 'immich-cf-account-v2',
        ownerId: owner,
        exportedAt: '2026-11-02T00:00:00.000Z',
        includesTrash: true,
        fullDatabaseBackup: false,
        snapshot: { ...snapshot },
        totals: { ...totals },
        page: {
          ...structuredClone(pages[n]),
          nextCursor: n + 1 < pages.length ? 'p' + (n + 1) : null,
        },
      };
      if (n === 1) {
        if (mode === 'duplicate') data.page.items[0] = structuredClone(assets[49]);
        if (mode === 'missing') data.page.items.pop();
        if (mode === 'changed-page') data.snapshot.assetRevision++;
        if (mode === 'foreign') data.ownerId = randomUUID();
        if (mode === 'cycle') data.page.nextCursor = 'p1';
        if (mode === 'foreign-path')
          data.page.items[0].downloadPath = 'https://private.invalid/steal';
        if (mode === 'unpaired') data.page.items[0].media_type = 'IMAGE';
      }
      if (data.page.kind === 'complete') {
        terminalReads++;
        if (mode === 'changed-final' && terminalReads > 1)
          return { metrics: { errorCode: null, status: 409 }, bytes: Buffer.from('{}') };
      }
      return {
        metrics: { errorCode: null, status: 200 },
        bytes: Buffer.from(JSON.stringify(data)),
      };
    }
    assert.ok(u.pathname.endsWith('/original'));
    const id = u.searchParams.get('id'),
      i = Number.parseInt(id.slice(-12), 16);
    downloads++;
    return {
      metrics: { errorCode: null, status: 200 },
      bytes:
        mode === 'corrupt' && i === 50 ? Buffer.from('CORRUPTED') : Buffer.from('original-' + i),
    };
  };
  return {
    out,
    assets,
    pages: pages.length,
    run: () =>
      exportAccount({
        baseUrl: 'https://example.invalid',
        userId: owner,
        credentials,
        out,
        request,
      }),
    downloads: () => downloads,
  };
}
test('分页导出跨页 Live Photo 与超过旧上限的相册关系，汇总 v2 并验证原件', async () => {
  const f = await fixture();
  const result = await f.run();
  assert.equal(result.assets, 121);
  assert.equal(f.downloads(), 121);
  const manifest = JSON.parse(await readFile(join(f.out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'immich-cf-account-v2');
  assert.equal(manifest.assets.length, 121);
  assert.equal(manifest.relations.length, 2400);
  assert.deepEqual(
    await readFile(join(f.out, f.assets[50].id + '.mov')),
    Buffer.from('original-50'),
  );
  await access(join(f.out, 'COMPLETE.json'));
  await assert.rejects(access(join(f.out, 'INCOMPLETE')));
});
test('分页重复、缺页、跨版本、游标循环、外部路径、错误配对和坏原件均不能标记完整', async () => {
  for (const mode of [
    'duplicate',
    'missing',
    'changed-page',
    'foreign',
    'cycle',
    'foreign-path',
    'unpaired',
    'corrupt',
    'changed-final',
  ]) {
    const f = await fixture(mode);
    await assert.rejects(f.run(), undefined, mode);
    await access(join(f.out, 'INCOMPLETE'));
    await assert.rejects(access(join(f.out, 'COMPLETE.json')));
  }
});
test('10,000 个逻辑资产的分批导出逐份校验 10,001 份原件并生成完成标记', async () => {
  const f = await fixture('large');
  const result = await f.run();
  assert.equal(result.assets, 10001);
  assert.equal(f.downloads(), 10001);
  assert.ok(f.pages > 200);
  const marker = JSON.parse(await readFile(join(f.out, 'COMPLETE.json'), 'utf8'));
  assert.equal(marker.assets, 10001);
  assert.equal(marker.hashVerified, true);
});
