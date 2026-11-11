import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
const bundle = await build({
  entryPoints: [path.resolve('src/geo.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { geoBounds, boundsKey, inGeoBounds, geoExtent, geoClusters, wrapLongitude } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

test('地图范围校验具体字段，支持零值、退化范围及跨日期变更线', () => {
  assert.equal(boundsKey(geoBounds('0,-180,0,180')), '0,-180,0,180');
  assert.equal(boundsKey(geoBounds('-0,-0,0,0')), '0,0,0,0');
  assert.equal(geoBounds('-1e-10,179,1e-10,-179').west, 179);
  for (const value of [
    '',
    '0,0,0',
    '1,0,-1,0',
    '-91,0,90,0',
    '0,181,0,0',
    '0,0,NaN,1',
    '0,0,0,Infinity',
    '0,0,0,1;DROP TABLE',
  ])
    assert.throws(
      () => geoBounds(value),
      (error) => error.field === 'bounds' && error.message.includes('地图范围：'),
    );
  const bounds = geoBounds('-10,170,10,-170');
  for (const longitude of [170, 179, -179, -170, 180, -180])
    assert.equal(inGeoBounds({ latitude: 0, longitude }, bounds), true);
  assert.equal(inGeoBounds({ latitude: 0, longitude: 0 }, bounds), false);
});

test('地图最小经度跨度跨越日期变更线，精密小数及正负 180 边界不丢失', () => {
  const points = [
    { latitude: 0, longitude: 179.9 },
    { latitude: 1, longitude: -179.8 },
  ];
  const extent = geoExtent(points);
  assert.equal(extent.west, 179.9);
  assert.equal(extent.east, -179.8);
  for (const point of points) assert.equal(inGeoBounds(point, extent), true);
  for (const longitude of [121.123456789, 0.0000000001, -179.999999999]) {
    assert.equal(wrapLongitude(longitude), longitude);
    const point = { latitude: 31.123456789, longitude };
    assert.equal(inGeoBounds(point, geoExtent([point])), true);
  }
  for (const longitude of [-180, 180])
    for (const other of [-180, 180])
      assert.equal(
        inGeoBounds({ latitude: 0, longitude: other }, geoExtent([{ latitude: 0, longitude }])),
        true,
      );
  assert.equal(geoExtent([]), null);
});

test('1001 个地图标记按缩放聚合，最多 512 组且数量、极点和代表照片不丢失', () => {
  const points = Array.from({ length: 1001 }, (_, i) => ({
    id: String(i),
    latitude: i === 0 ? 90 : i === 1 ? -90 : -80 + i * 0.159,
    longitude: i % 2 ? -179 + i * 0.3 : 170 - i * 0.3,
  }));
  const result = geoClusters(points, 19);
  assert.ok(result.clusters.length <= 512);
  assert.equal(
    result.clusters.reduce((sum, group) => sum + group.count, 0),
    1001,
  );
  assert.ok(
    result.clusters.every(
      (group) =>
        group.count > 0 &&
        Number.isFinite(group.latitude) &&
        Number.isFinite(group.longitude) &&
        points.some((p) => p.id === group.coverId),
    ),
  );
  for (const point of points)
    assert.ok(result.clusters.some((group) => inGeoBounds(point, group.bounds)));
});

test('同一 GPS 的 1001 张照片聚成一组，缩放不会截断、计重或生成虚假位移', () => {
  const points = Array.from({ length: 1001 }, (_, i) => ({
    id: String(i),
    latitude: 31.2083333,
    longitude: 121.5,
  }));
  for (const zoom of [0, 2, 12, 19]) {
    const result = geoClusters(points, zoom);
    assert.equal(result.clusters.length, 1);
    assert.equal(result.clusters[0].count, 1001);
    assert.deepEqual(result.clusters[0].bounds, {
      south: 31.2083333,
      north: 31.2083333,
      west: 121.5,
      east: 121.5,
    });
    assert.equal(result.clusters[0].coverId, '0');
  }
});
