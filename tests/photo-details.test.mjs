import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { photoTiff } from './fixtures/photo-metadata.mjs';
const require = createRequire(import.meta.url),
  { build } = createRequire(require.resolve('wrangler'))('esbuild');
async function module(file) {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const time = await module('src/photo-time.ts'),
  exif = await module('src/poc/photo-exif.ts');
test('拍摄时间按 IANA 与固定偏移解析，跨年和夏令时空缺/重复时刻不被静默改写', () => {
  assert.equal(
    time.resolvePhotoTime('2020-01-01T00:30', 'Asia/Shanghai').time,
    '2019-12-31T16:30:00.000Z',
  );
  assert.equal(
    time.resolvePhotoTime('2020-01-01T00:30:00.125', '+08:00').time,
    '2019-12-31T16:30:00.125Z',
  );
  assert.equal(
    time.resolvePhotoTime('2026-11-01T01:30', 'America/Los_Angeles', 'earlier').time,
    '2026-11-01T08:30:00.000Z',
  );
  assert.equal(
    time.resolvePhotoTime('2026-11-01T01:30', 'America/Los_Angeles', 'later').time,
    '2026-11-01T09:30:00.000Z',
  );
  assert.throws(() => time.resolvePhotoTime('2026-03-08T02:30', 'America/Los_Angeles'), /不存在/);
  for (const bad of [
    '2025-02-29T00:00',
    '2026-02-30T00:00',
    '2026-01-01T24:00',
    '0000-01-01T00:00',
  ])
    assert.throws(() => time.resolvePhotoTime(bad, 'UTC'), /拍摄时间/);
  for (const bad of ['bad-zone', '+14:30', '+08:99', ''])
    assert.throws(() => time.resolvePhotoTime('2026-01-01T00:00', bad), /拍摄时区/);
  assert.equal(
    time.photoWallTime('2026-03-08T10:00:00.125Z', 'America/Los_Angeles'),
    '2026-03-08T03:00:00.125',
  );
});
test('EXIF 白名单读取大小端 TIFF、相机参数、原始日期/偏移、GPS，并有界跳过坏指针与循环', () => {
  for (const little of [false, true]) {
    const data = exif.photoExif(photoTiff({ little }));
    assert.equal(data.make, 'Example Camera');
    assert.equal(data.model, 'Test Model');
    assert.equal(data.description, '原件说明');
    assert.equal(data.iso, 200);
    assert.equal(data.fNumber, 2.8);
    assert.equal(data.exposureTime, '1/125');
    assert.equal(data.focalLength, 35);
    assert.equal(data.originalDateTime, '2020-01-01T00:30:00.125');
    assert.equal(data.originalOffset, '+08:00');
    assert.equal(data.latitude, 31.2083333);
    assert.equal(data.longitude, 121.5);
    assert.equal(data.warning, undefined);
  }
  const invalid = Buffer.from(photoTiff());
  invalid.writeUInt32BE(0xfffffff0, 8 + 2 + 4 * 12 + 8);
  assert.match(exif.photoExif(invalid).warning, /无效|无法/);
  const loop = Buffer.from(photoTiff());
  loop.writeUInt32BE(8, 8 + 2 + 4 * 12 + 8);
  assert.match(exif.photoExif(loop).warning, /无效|无法/);
  assert.match(exif.photoExif(Buffer.alloc(5)).warning, /无法/);
  assert.equal(exif.photoExif(photoTiff({ offset: null })).originalOffset, undefined);
});
