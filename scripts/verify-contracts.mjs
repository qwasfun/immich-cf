import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const json = (path) => JSON.parse(read(path));
const manifest = json('docs/compatibility-manifest.json');
const raw = read(`docs/${manifest.upstream.openapi.file}`);
assert.equal(
  createHash('sha256').update(raw).digest('hex'),
  manifest.upstream.openapi.sha256,
  'OpenAPI 原件摘要发生变化',
);
const spec = JSON.parse(raw);
assert.equal(spec.info.version, manifest.upstream.openapi.version);
assert.equal(`v${spec.info.version}`, manifest.upstream.tag);
assert.deepEqual(spec.servers, [{ url: '/api' }]);
const operations = [];
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!op.operationId) continue;
    operations.push({
      operationId: op.operationId,
      method: method.toUpperCase(),
      path: `/api${path}`,
      security: op.security ?? spec.security ?? [],
      parameters: op.parameters ?? [],
      requestBody: op.requestBody ?? null,
      responses: op.responses,
    });
  }
}
assert.deepEqual(json('docs/contracts/operations.json'), operations, '操作清单与上游不一致');
assert.equal(new Set(operations.map((o) => o.operationId)).size, operations.length);
assert.deepEqual(manifest.sync.requestEnum, spec.components.schemas.SyncRequestType.enum);
assert.deepEqual(manifest.sync.entityEnum, spec.components.schemas.SyncEntityType.enum);
assert.equal(new Set(manifest.sync.requestedTypes).size, manifest.sync.requestedTypes.length);
for (const type of manifest.sync.requestedTypes)
  assert.ok(manifest.sync.requestEnum.includes(type), type);
const inventory = json('docs/contracts/source-inventory.json');
assert.equal(inventory.commit, manifest.upstream.commit);
for (const file of inventory.files) {
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    file.url,
    `https://raw.githubusercontent.com/immich-app/immich/${inventory.commit}/${file.path}`,
  );
}
assert.equal(
  inventory.files.find((f) => f.path === 'open-api/immich-openapi-specs.json').sha256,
  manifest.upstream.openapi.sha256,
);
assert.equal(
  createHash('sha256')
    .update(read(`docs/${manifest.upstream.license}`))
    .digest('hex'),
  inventory.files.find((f) => f.path === 'LICENSE').sha256,
);
console.log(
  `通过：OpenAPI/许可证摘要、${operations.length} 个操作、同步枚举与 ${inventory.files.length} 个来源记录一致。`,
);
console.log('边界：未执行参考服务端、官方 App、传输测试或实机差分验证。');
