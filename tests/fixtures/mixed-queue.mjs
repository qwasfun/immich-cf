import { crc32 } from 'node:zlib';
import { readFile } from 'node:fs/promises';
export async function mixedCases() {
  const png = await readFile('tests/fixtures/small.png');
  const jpg = await readFile('tests/fixtures/small.jpg');
  const padded = (size) => {
    const chunk = Buffer.alloc(size - png.length);
    chunk.writeUInt32BE(chunk.length - 12);
    chunk.write('tEXt', 4);
    chunk.write('Comment\0', 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  };
  return [
    { name: 'small-png', bytes: png, status: 201 },
    { name: 'over-limit', bytes: padded(4 * 1024 * 1024 + 1), status: 413, field: 'assetData' },
    {
      name: 'heic-signature',
      bytes: Buffer.from('00000018667479706865696300000000686569636d696631', 'hex'),
      status: 400,
      field: 'assetData',
    },
    {
      name: 'video-signature',
      bytes: Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'),
      status: 400,
      field: 'assetData',
    },
    {
      name: 'live-photo-link',
      bytes: jpg,
      fields: { livePhotoVideoId: '11111111-1111-4111-8111-111111111111' },
      status: 400,
      field: 'livePhotoVideoId',
    },
    {
      name: 'sidecar',
      bytes: jpg,
      fields: { sidecarData: 'unsupported' },
      status: 400,
      field: 'sidecarData',
    },
    {
      name: 'live-video-hidden',
      bytes: jpg,
      fields: { visibility: 'hidden' },
      status: 400,
      field: 'visibility',
    },
    { name: 'below-limit', bytes: padded(4 * 1024 * 1024 - 1), status: 201 },
    { name: 'at-limit', bytes: padded(4 * 1024 * 1024), status: 201 },
    { name: 'small-jpeg', bytes: jpg, status: 201 },
  ];
}
export async function encodedUpload(item) {
  const form = new FormData();
  form.set('assetData', new File([item.bytes], `queue-${item.name}.bin`, { type: 'image/jpeg' }));
  form.set('fileCreatedAt', '2026-10-15T00:00:00Z');
  form.set('fileModifiedAt', '2026-10-15T00:00:00Z');
  for (const [key, value] of Object.entries(item.fields ?? {})) form.set(key, value);
  const request = new Request('http://localhost/api/assets', { method: 'POST', body: form });
  return {
    type: request.headers.get('content-type'),
    bytes: new Uint8Array(await request.arrayBuffer()),
  };
}
