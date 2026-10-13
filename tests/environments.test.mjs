import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const config = JSON.parse(readFileSync('wrangler.json'));
test('dev 远程绑定与 test/prod 隔离；生产名称无 prod 后缀', () => {
  assert.deepEqual(Object.keys(config.env).sort(), ['dev', 'prod', 'test']);
  const names = new Set(),
    databases = new Set(),
    buckets = new Set();
  for (const [name, env] of Object.entries(config.env)) {
    names.add(env.name);
    databases.add(env.d1_databases[0].database_name);
    buckets.add(env.r2_buckets[0].bucket_name);
    assert.equal(env.vars.ENABLE_P1_POC, name === 'dev' ? 'true' : 'false');
    for (const binding of [...env.d1_databases, ...env.r2_buckets])
      assert.equal(binding.remote === true, name === 'dev');
  }
  for (const set of [names, databases, buckets]) assert.equal(set.size, 3);
  assert.equal(config.env.prod.name, 'immich-cf-api');
  assert.equal(config.env.prod.d1_databases[0].database_name, 'immich-cf-db');
  assert.equal(config.env.prod.r2_buckets[0].bucket_name, 'immich-cf-media');
});
