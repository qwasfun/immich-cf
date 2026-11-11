import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
const bundle = await build({
  entryPoints: [path.resolve('src/memory-date.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { memoryDate, memoryContext, memoryDayRanges } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

test('回忆日期严格校验、当地今天与参考年份，不回显错误输入', () => {
  assert.equal(memoryDate('2024-02-29'), '2024-02-29');
  for (const input of [
    '',
    null,
    '0000-01-01',
    '2023-02-29',
    '2024-02-30',
    '2026-1-1',
    'private-invalid-value',
  ])
    assert.throws(
      () => memoryDate(input),
      (error) => error.field === 'memoryDate' && !error.message.includes('private-invalid-value'),
    );
  const now = new Date('2025-12-31T18:00:00.000Z');
  assert.deepEqual(memoryContext(new URLSearchParams({ timeZone: 'Asia/Shanghai' }), now), {
    date: '2026-01-01',
    timeZone: 'Asia/Shanghai',
    year: 2026,
  });
  assert.equal(
    memoryContext(new URLSearchParams({ timeZone: 'America/Los_Angeles' }), now).date,
    '2025-12-31',
  );
  assert.throws(
    () =>
      memoryContext(
        new URLSearchParams({ memoryDate: '2026-01-02', timeZone: 'Asia/Shanghai' }),
        now,
      ),
    /不能晚于当地今天/,
  );
});

test('回忆日界覆盖上海跨年以及夏令时 23 和 25 小时，重复小时全量包含', () => {
  assert.deepEqual(memoryDayRanges('2024-01-01', 'Asia/Shanghai'), [
    { from: '2023-12-31T16:00:00.000Z', to: '2024-01-01T16:00:00.000Z' },
  ]);
  assert.deepEqual(memoryDayRanges('2024-03-10', 'America/Los_Angeles'), [
    { from: '2024-03-10T08:00:00.000Z', to: '2024-03-11T07:00:00.000Z' },
  ]);
  assert.deepEqual(memoryDayRanges('2024-11-03', 'America/Los_Angeles'), [
    { from: '2024-11-03T07:00:00.000Z', to: '2024-11-04T08:00:00.000Z' },
  ]);
});

test('回忆日界支持午夜跳时、整日跳过与闰日，固定时差不改变日期语义', () => {
  assert.deepEqual(memoryDayRanges('2018-11-04', 'America/Sao_Paulo'), [
    { from: '2018-11-04T03:00:00.000Z', to: '2018-11-05T02:00:00.000Z' },
  ]);
  assert.deepEqual(memoryDayRanges('2011-12-30', 'Pacific/Apia'), []);
  assert.deepEqual(memoryDayRanges('2024-02-29', '+08:00'), [
    { from: '2024-02-28T16:00:00.000Z', to: '2024-02-29T16:00:00.000Z' },
  ]);
});
