import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Only synthetic fixture values enter this report; IDs, credentials and URLs stay in memory.
export async function compareNonempty({ targets, tokens, request, shape }) {
  const report = { scope: 'two-static-images-upload-sync-reset-media', targets: {} };
  const fixtures = await Promise.all(
    ['small.png', 'small.jpg'].map(async (file) => ({
      file,
      bytes: await readFile(`tests/fixtures/${file}`),
    })),
  );
  for (const [key, fetcher] of Object.entries(targets)) {
    const token = tokens[key];
    const headers = { Authorization: `Bearer ${token}` };
    const uploads = [];
    const media = [];
    const ids = [];
    const upload = async (fixture, index) => {
      const form = new FormData();
      form.set('assetData', new File([fixture.bytes], `参考图片-${fixture.file}`));
      form.set('fileCreatedAt', '2026-10-14T00:00:00.000Z');
      form.set('fileModifiedAt', '2026-10-14T00:00:00.000Z');
      form.set('isFavorite', String(index === 0));
      form.set(
        'metadata',
        JSON.stringify([{ key: 'mobile-app', value: { cloudId: `fixture-${index}` } }]),
      );
      const encoded = new Request('http://localhost/api/assets', {
        method: 'POST',
        headers,
        body: form,
      });
      const response = await fetcher('/api/assets', {
        method: 'POST',
        headers: Object.fromEntries(encoded.headers),
        body: await encoded.arrayBuffer(),
      });
      return { status: response.status, value: await response.json() };
    };
    for (const [index, fixture] of fixtures.entries()) {
      const first = await upload(fixture, index);
      assert.equal(
        first.status,
        201,
        `${key} upload ${fixture.file}: ${JSON.stringify(first.value)}`,
      );
      assert.equal(first.value.status, 'created');
      ids.push(first.value.id);
      const duplicate = await upload(fixture, index);
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.value.id, first.value.id);
      assert.equal(duplicate.value.status, 'duplicate');
      uploads.push({
        file: fixture.file,
        created: first.status,
        duplicate: duplicate.status,
        sameId: true,
      });
      const original = await fetcher(`/api/assets/${first.value.id}/original`, { headers });
      assert.equal(original.status, 200);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), fixture.bytes);
      // Official thumbnails are asynchronous derivatives. Bound readiness; never treat 404 as a pass.
      let preview;
      for (let attempt = 0; attempt < 60; attempt++) {
        preview = await fetcher(`/api/assets/${first.value.id}/thumbnail?size=preview`, {
          headers,
        });
        if (preview.status === 200) break;
        await preview.arrayBuffer();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(preview.status, 200, `${key} preview readiness`);
      const bytes = Buffer.from(await preview.arrayBuffer());
      assert.ok(bytes.length > 0);
      assert.ok(
        bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
          bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        'Preview must have JPEG or PNG signature',
      );
      assert.match(preview.headers.get('content-type'), /^image\//);
      const denied = await fetcher(`/api/assets/${first.value.id}/original`, {});
      assert.equal(denied.status, 401);
      await denied.arrayBuffer();
      media.push({
        file: fixture.file,
        originalMatches: true,
        previewStatus: 200,
        previewMime: preview.headers.get('content-type'),
        previewBytes: bytes.length,
        previewEqualsOriginal: bytes.equals(fixture.bytes),
        unauthenticated: 401,
      });
    }
    const types = ['AuthUsersV2', 'UsersV1', 'AssetsV2', 'AssetMetadataV1'];
    const stream = async (reset = false) => {
      const result = await request(fetcher, '/api/sync/stream', 'POST', { types, reset }, token);
      assert.equal(result.status, 200);
      assert.equal(result.value.at(-1).type, 'SyncCompleteV1');
      return result.value;
    };
    const ack = async (events) =>
      assert.equal(
        (await request(fetcher, '/api/sync/ack', 'POST', { acks: events.map((e) => e.ack) }, token))
          .status,
        204,
      );
    const verify = (events) => {
      const assets = events.filter((e) => e.type === 'AssetV2');
      assert.equal(assets.length, 2);
      assert.deepEqual(
        events.filter((e) => ['AssetV2', 'AssetMetadataV1'].includes(e.type)).map((e) => e.type),
        ['AssetV2', 'AssetV2', 'AssetMetadataV1', 'AssetMetadataV1'],
      );
      assert.equal(new Set(assets.map((e) => e.data.id)).size, 2);
      for (const [index, fixture] of fixtures.entries()) {
        const asset = assets.find((e) => e.data.id === ids[index]);
        assert.ok(asset);
        assert.equal(
          asset.data.checksum,
          createHash('sha1').update(fixture.bytes).digest('base64'),
        );
        assert.equal(asset.data.type, 'IMAGE');
        assert.equal(asset.data.width, 320);
        assert.equal(asset.data.height, 240);
        for (const field of ['fileCreatedAt', 'fileModifiedAt'])
          assert.equal(Date.parse(asset.data[field]), Date.parse('2026-10-14T00:00:00.000Z'));
        assert.equal(asset.data.originalFileName, `参考图片-${fixture.file}`);
        assert.equal(asset.data.isFavorite, index === 0);
        assert.equal(asset.data.visibility, 'timeline');
        const metadata = events.filter(
          (e) => e.type === 'AssetMetadataV1' && e.data.assetId === ids[index],
        );
        assert.equal(metadata.length, 1);
        assert.equal(metadata[0].data.key, 'mobile-app');
        assert.deepEqual(metadata[0].data.value, { cloudId: `fixture-${index}` });
      }
      return assets.map((e) => ({
        file: fixtures[ids.indexOf(e.data.id)].file,
        shape: shape(e.data),
        width: e.data.width,
        height: e.data.height,
      }));
    };
    const initial = await stream();
    const assetShapes = verify(initial);
    // Without ACK, every asset remains replayable (models a lost/interrupted response).
    const replay = await stream();
    verify(replay);
    const firstAsset = replay.find((e) => e.type === 'AssetV2');
    await ack([firstAsset]);
    const partial = await stream();
    assert.deepEqual(
      partial.filter((e) => e.type === 'AssetV2').map((e) => e.data.id),
      ids.filter((id) => id !== firstAsset.data.id),
    );
    assert.equal(partial.filter((e) => e.type === 'AssetMetadataV1').length, 2);
    await ack(partial);
    assert.deepEqual(
      (await stream()).map((e) => e.type),
      ['SyncCompleteV1'],
    );
    const reset = await stream(true);
    verify(reset);
    assert.ok(!reset.some((e) => e.type === 'SyncResetV1'));
    for (const id of ids) {
      const assetIndex = reset.findIndex((e) => e.type === 'AssetV2' && e.data.id === id);
      const owner = reset[assetIndex].data.ownerId;
      assert.ok(reset.findIndex((e) => e.type === 'UserV1' && e.data.id === owner) >= 0);
      assert.ok(reset.findIndex((e) => e.type === 'UserV1' && e.data.id === owner) < assetIndex);
    }
    await ack(reset);
    assert.deepEqual(
      (await stream()).map((e) => e.type),
      ['SyncCompleteV1'],
    );
    report.targets[key] = {
      uploads,
      media,
      assetShapes,
      initialTypes: initial.map((e) => e.type),
      resetTypes: reset.map((e) => e.type),
      replayWithoutAck: true,
      partialAssetAckPreservesMetadata: true,
      ackThenEmptyIncremental: true,
      resetThenEmptyIncremental: true,
    };
  }
  return report;
}
