import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
const bundle = await build({
  entryPoints: [path.resolve('web/src/timeline-state.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const source =
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64');
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
test('地图新开区域沿用地图当前筛选，历史条目仍可恢复该区域原筛选', async () => {
  globalThis.sessionStorage = new Storage();
  const state = await import(source + '#map-entry');
  state.timelineAccount('map-owner');
  const stored = {
    query: { q: '旧筛选', from: '', to: '', type: 'all', order: 'newest', tag: '', rating: 'all' },
    anchor: null,
  };
  state.saveTimeline('map-owner', 'old-entry', 'map:bounds', stored);
  assert.deepEqual(state.readTimeline('map-owner', 'old-entry', 'map:bounds', true), stored);
  assert.equal(state.readTimeline('map-owner', 'new-entry', 'map:bounds', true), null);
  assert.deepEqual(state.readTimeline('map-owner', 'new-entry', 'map:bounds'), stored);
});
const saved = {
  query: { q: '旅行', from: '', to: '', type: 'jpeg', order: 'oldest', tag: '', rating: 'all' },
  anchor: {
    id: 'b230a5f8-adbb-43ba-8696-e93f811af9cd',
    time: '2021-06-10T10:00:00.000Z',
    offset: 80,
  },
};

test('时间线刷新保留同账号位置和筛选，切换账号、退出及过期会话清除历史', async () => {
  globalThis.sessionStorage = new Storage();
  const first = await import(source + '#first');
  first.timelineAccount('alice');
  first.saveTimeline('alice', 'entry', 'photos:', saved);
  assert.deepEqual(first.readTimeline('alice', 'entry', 'photos:'), saved);
  const reload = await import(source + '#reload');
  reload.timelineAccount('alice');
  assert.deepEqual(reload.readTimeline('alice', 'entry', 'photos:'), saved);
  assert.deepEqual(reload.readTimeline('alice', 'new-navigation-entry', 'photos:'), saved);
  const legacyQuery = { ...saved.query };
  delete legacyQuery.tag;
  delete legacyQuery.rating;
  first.saveTimeline('alice', 'legacy', 'photos:', { ...saved, query: legacyQuery });
  const legacy = await import(source + '#legacy');
  legacy.timelineAccount('alice');
  assert.deepEqual(legacy.readTimeline('alice', 'legacy', 'photos:').query, saved.query);
  assert.equal(reload.readTimeline('bob', 'entry', 'photos:'), null);
  reload.timelineAccount('bob');
  assert.equal(reload.readTimeline('alice', 'entry', 'photos:'), null);
  reload.saveTimeline('alice', 'entry', 'photos:', saved);
  assert.equal(reload.readTimeline('alice', 'entry', 'photos:'), null);
  reload.saveTimeline('bob', 'entry', 'photos:', saved);
  const expired = await import(source + '#expired');
  expired.timelineAccount(null);
  assert.equal(expired.readTimeline('bob', 'entry', 'photos:'), null);
});

test('超过历史容量后仍保留账号标记与最近位置，存储禁用时导航可使用内存状态', async () => {
  globalThis.sessionStorage = new Storage();
  const state = await import(source + '#bounded');
  state.timelineAccount('alice');
  for (let i = 0; i < 110; i++) state.saveTimeline('alice', String(i), 'photos:', saved);
  assert.equal(Object.keys(sessionStorage).length, 101);
  const reload = await import(source + '#bounded-reload');
  reload.timelineAccount('alice');
  assert.deepEqual(reload.readTimeline('alice', '109', 'photos:'), saved);
  assert.deepEqual(reload.readTimeline('alice', '0', 'photos:'), saved);
  globalThis.sessionStorage = new Proxy(
    {},
    {
      get() {
        throw Error('disabled');
      },
      ownKeys() {
        throw Error('disabled');
      },
    },
  );
  const fallback = await import(source + '#fallback');
  fallback.timelineAccount('alice');
  fallback.saveTimeline('alice', 'entry', 'photos:', saved);
  assert.deepEqual(fallback.readTimeline('alice', 'entry', 'photos:'), saved);
  assert.deepEqual(fallback.readTimeline('alice', 'next-entry', 'photos:'), saved);
});
