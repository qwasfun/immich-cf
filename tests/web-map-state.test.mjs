import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
async function moduleAt(file) {
  const bundle = await build({
    entryPoints: [path.resolve(file)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );
}
const { readMap, saveMap } = await moduleAt('web/src/map-state.ts');
const { timelineAccount } = await moduleAt('web/src/timeline-state.ts');
class Storage {
  getItem(key) {
    return this[key] ?? null;
  }
  setItem(key, value) {
    this[key] = String(value);
  }
  removeItem(key) {
    delete this[key];
  }
}
const saved = {
  center: [31.2, 121.5],
  zoom: 13,
  mapView: 'library',
  albumId: '',
  basemap: false,
  query: { q: '海边', from: '', to: '', type: 'all', order: 'newest', tag: '', rating: 'all' },
};
test('地图位置和筛选按账号/历史条目保存，退出和切换账号清除', () => {
  globalThis.sessionStorage = new Storage();
  timelineAccount('map-alice');
  saveMap('map-alice', 'first', saved);
  assert.deepEqual(readMap('map-alice', 'first'), saved);
  assert.deepEqual(readMap('map-alice', 'new-entry'), saved);
  saveMap('map-alice', 'second', { ...saved, zoom: 4 });
  assert.equal(readMap('map-alice', 'first').zoom, 13);
  assert.equal(readMap('map-bob', 'first'), null);
  timelineAccount(null);
  assert.equal(readMap('map-alice', 'first'), null);
  timelineAccount('map-bob');
  saveMap('map-bob', 'world', { ...saved, zoom: 0 });
  assert.equal(readMap('map-bob', 'world').zoom, 0);
  saveMap('map-alice', 'first', saved);
  assert.equal(readMap('map-alice', 'first'), null);
});
test('地图历史记录有界，损坏、非法位置和存储禁用时安全回退', () => {
  globalThis.sessionStorage = new Storage();
  timelineAccount('map-bob');
  for (let i = 0; i < 50; i++) saveMap('map-bob', String(i), saved);
  assert.ok(Object.keys(sessionStorage).filter((key) => key.includes(':map:')).length <= 31);
  for (const bad of [
    { ...saved, center: [100, 121] },
    { ...saved, zoom: -1 },
    { ...saved, mapView: 'trash' },
    { ...saved, mapView: 'album', albumId: '' },
  ]) {
    sessionStorage.setItem('immich-cf-timeline:map-bob:map:bad', JSON.stringify(bad));
    assert.equal(readMap('map-bob', 'bad'), null);
  }
  globalThis.sessionStorage = {
    getItem() {
      throw Error('disabled');
    },
    setItem() {
      throw Error('disabled');
    },
  };
  assert.doesNotThrow(() => saveMap('map-bob', 'first', saved));
  assert.equal(readMap('map-bob', 'first'), null);
});
