import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { exportAccount } from '../scripts/admin-export.mjs';
async function fixture(mode = 'ok') {
  const dir = await mkdtemp(join(tmpdir(), 'immich-export-')),
    owner = randomUUID(),
    id = randomUUID(),
    bytes = Buffer.from('synthetic original');
  const credentials = join(dir, 'credentials.json'),
    out = join(dir, 'export');
  await writeFile(credentials, JSON.stringify({ accessToken: 'a'.repeat(64) }));
  const path = `/api/immich-cf/admin/export/original?userId=${owner}&id=${id}&revision=1`;
  const manifest = {
    format: 'immich-cf-account-v1',
    ownerId: owner,
    assets: [
      {
        id,
        mime: 'image/png',
        bytes: bytes.length,
        checksum: createHash('sha1').update(bytes).digest('base64'),
        sync_seq: 1,
        downloadPath: path,
      },
    ],
    albums: [],
    relations: [],
  };
  let videoId;
  if (mode.startsWith('v2')) {
    manifest.format = 'immich-cf-account-v2';
    videoId = randomUUID();
    Object.assign(manifest.assets[0], {
      media_type: 'IMAGE',
      visibility: 'timeline',
      deleted_at: null,
      live_photo_video_id: videoId,
    });
    if (mode !== 'v2-incomplete')
      manifest.assets.push({
        ...manifest.assets[0],
        id: videoId,
        mime: 'video/quicktime',
        media_type: 'VIDEO',
        visibility: 'hidden',
        live_photo_video_id: null,
        downloadPath: `/api/immich-cf/admin/export/original?userId=${owner}&id=${videoId}&revision=1`,
      });
  }
  let reads = 0,
    media = 0;
  const request = async (url, options) => {
    assert.equal(options.method, 'GET');
    if (url.includes('/export/page?'))
      return { metrics: { errorCode: null, status: 404 }, bytes: Buffer.from('{}') };
    if (url.includes('/original?')) {
      media++;
      if (mode === 'timeout' && media < 3)
        return { metrics: { errorCode: 'CURL_28', status: 0 }, bytes: null };
      return {
        metrics: { errorCode: null, status: 200 },
        bytes:
          mode === 'corrupt' || (mode === 'v2-corrupt' && url.includes(videoId))
            ? Buffer.alloc(bytes.length)
            : bytes,
      };
    }
    reads++;
    const data = structuredClone(manifest);
    if (mode === 'changed' && reads > 1)
      data.relations.push({ album_id: randomUUID(), asset_id: id });
    if (mode === 'foreign') data.assets[0].downloadPath = 'https://private.invalid/steal';
    return { metrics: { errorCode: null, status: 200 }, bytes: Buffer.from(JSON.stringify(data)) };
  };
  return {
    dir,
    out,
    bytes,
    id,
    videoId,
    run: () =>
      exportAccount({
        baseUrl: 'https://example.invalid',
        userId: owner,
        credentials,
        out,
        request,
      }),
    getMedia: () => media,
  };
}
test('导出工具完整验哈希后原子标记成功，重复目标目录不覆盖', async () => {
  const f = await fixture();
  assert.equal((await f.run()).assets, 1);
  assert.deepEqual(await readFile(join(f.out, f.id + '.png')), f.bytes);
  await access(join(f.out, 'COMPLETE.json'));
  await assert.rejects(access(join(f.out, 'INCOMPLETE')));
  await assert.rejects(f.run());
});
test('导出工具拒绝等长损坏、下载期间关系变化和外部路径，失败不写完成标记', async () => {
  for (const mode of ['corrupt', 'changed', 'foreign']) {
    const f = await fixture(mode);
    await assert.rejects(f.run());
    await access(join(f.out, 'INCOMPLETE'));
    await assert.rejects(access(join(f.out, 'COMPLETE.json')));
    if (mode === 'foreign') assert.equal(f.getMedia(), 0);
  }
});
test('导出工具复用curl有界重试恢复超时，凭据不进入清单', async () => {
  const f = await fixture('timeout');
  await f.run();
  assert.equal(f.getMedia(), 3);
  assert.ok(!(await readFile(join(f.out, 'manifest.json'), 'utf8')).includes('a'.repeat(64)));
});
test('v2 导出保留配对 MOV；缺失或损坏动态部分不得生成完整标记', async () => {
  const f = await fixture('v2');
  assert.equal((await f.run()).assets, 2);
  assert.deepEqual(await readFile(join(f.out, f.videoId + '.mov')), f.bytes);
  await access(join(f.out, 'COMPLETE.json'));
  for (const mode of ['v2-incomplete', 'v2-corrupt']) {
    const broken = await fixture(mode);
    await assert.rejects(broken.run());
    await access(join(broken.out, 'INCOMPLETE'));
    await assert.rejects(access(join(broken.out, 'COMPLETE.json')));
  }
});
