import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
async function load(file) {
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
const { photoSelection } = await load('web/src/photo-selection.ts');
const { fitView, fittedImage, boundedView, zoomView } = await load('web/src/viewer-geometry.ts');
const ids = Array.from({ length: 1001 }, (_, i) => String(i));

test('Shift ranges follow displayed order in either direction and preserve other selections', () => {
  const initial = photoSelection(ids, new Set(['900']), null, '20', false);
  const forward = photoSelection(ids, initial.selected, initial.anchor, '25', true);
  assert.deepEqual([...forward.selected], ['900', '20', '21', '22', '23', '24', '25']);
  assert.deepEqual(forward.anchor, { id: '20' });
  const backward = photoSelection(ids, forward.selected, forward.anchor, '18', true);
  assert.deepEqual([...backward.selected], ['900', '20', '21', '22', '23', '24', '25', '18', '19']);
  const deselected = photoSelection(ids, backward.selected, backward.anchor, '24', true);
  assert.deepEqual([...deselected.selected], ['900', '25', '18', '19']);
  assert.equal(deselected.anchor.id, '20');
});

test('Range anchors use photo IDs after pagination and work with reverse sorting', () => {
  const anchor = { id: '25' };
  const result = photoSelection(ids, new Set(['25']), anchor, '30', true);
  assert.deepEqual([...result.selected], ['25', '26', '27', '28', '29', '30']);
  const reverse = photoSelection([...ids].reverse(), new Set(['25']), anchor, '20', true);
  assert.deepEqual([...reverse.selected], ['25', '24', '23', '22', '21', '20']);
  const missing = photoSelection(ids.slice(100), new Set(['25']), anchor, '105', true);
  assert.deepEqual([...missing.selected], ['25', '105']);
  assert.equal(missing.anchor.id, '105');
  const invalid = photoSelection(ids, result.selected, anchor, 'missing', true);
  assert.deepEqual(invalid.selected, result.selected);
});

test('1001-photo ranges fail atomically; exactly 1000 and deselection remain possible', () => {
  const selected = new Set(['0']);
  const overflow = photoSelection(ids, selected, { id: '0' }, '1000', true);
  assert.equal(overflow.overflow, true);
  assert.deepEqual([...overflow.selected], ['0']);
  assert.deepEqual([...selected], ['0']);
  const full = photoSelection(ids, selected, { id: '0' }, '999', true);
  assert.equal(full.overflow, false);
  assert.equal(full.selected.size, 1000);
  const remove = photoSelection(ids, full.selected, full.anchor, '999', true);
  assert.equal(remove.selected.size, 0);
  assert.equal(remove.overflow, false);
});

test('Fit preserves portrait/landscape aspect ratios and tolerates unloaded image dimensions', () => {
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(fittedImage(viewport, { width: 1600, height: 900 }), {
    width: 800,
    height: 450,
  });
  assert.deepEqual(fittedImage(viewport, { width: 400, height: 1200 }), {
    width: 200,
    height: 600,
  });
  assert.deepEqual(fittedImage(viewport, { width: 0, height: 0 }), { width: 0, height: 0 });
  assert.deepEqual(
    boundedView({ scale: 0.1, x: 1000, y: -1000 }, viewport, { width: 64, height: 48 }),
    fitView(),
  );
});

test('Zoom clamps pan to visible image edges and recenters smaller axes after resize', () => {
  const viewport = { width: 800, height: 600 },
    image = { width: 1600, height: 900 };
  assert.deepEqual(boundedView({ scale: 2, x: 9999, y: -9999 }, viewport, image), {
    scale: 2,
    x: 400,
    y: -150,
  });
  assert.deepEqual(boundedView({ scale: 99, x: -9999, y: 9999 }, viewport, image), {
    scale: 4,
    x: -1200,
    y: 600,
  });
  assert.deepEqual(boundedView({ scale: 2, x: 400, y: 150 }, { width: 800, height: 2000 }, image), {
    scale: 2,
    x: 400,
    y: 0,
  });
  const portrait = boundedView({ scale: 2, x: 900, y: 900 }, viewport, {
    width: 400,
    height: 1200,
  });
  assert.deepEqual(portrait, { scale: 2, x: 0, y: 300 });
});

test('Cursor-centered zoom retains its focal image coordinate and returns to fit', () => {
  const viewport = { width: 800, height: 600 },
    image = { width: 800, height: 600 },
    point = { x: 100, y: -80 };
  const zoomed = zoomView(fitView(), 2, point, viewport, image);
  assert.deepEqual(zoomed, { scale: 2, x: -100, y: 80 });
  assert.equal((point.x - zoomed.x) / zoomed.scale, point.x);
  assert.equal((point.y - zoomed.y) / zoomed.scale, point.y);
  assert.deepEqual(zoomView(zoomed, 1, point, viewport, image), fitView());
});
