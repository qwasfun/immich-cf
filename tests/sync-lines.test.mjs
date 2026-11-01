import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncLines } from '../src/poc/sync-lines.ts';
import { decodeFrozenFraming } from './helpers/sync-framing.mjs';

const events = [
  { type: 'UserV1', data: { name: '相册🖼️', nullable: null }, ack: 'UserV1|1' },
  {
    type: 'AssetV2',
    data: { originalFileName: '照片📷\n第二行.jpg', width: 320, height: 240 },
    ack: 'AssetV2|2',
  },
  { type: 'SyncCompleteV1', data: {}, ack: 'SyncCompleteV1|019e0000-0000-7000-8000-000000000001' },
];

test('异步分页源遵循背压，取消时释放源，失败时不伪造 SyncComplete', async () => {
  let fetched = 0,
    closed = false;
  async function* pages() {
    try {
      for (const event of events) {
        fetched++;
        yield event;
      }
    } finally {
      closed = true;
    }
  }
  const response = syncLines(pages());
  assert.equal(fetched, 0);
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(fetched, 1);
  await reader.cancel();
  assert.equal(fetched, 1);
  assert.equal(closed, true);
  async function* broken() {
    yield events[0];
    throw Error('TEST_PAGE_CHANGED');
  }
  const failed = syncLines(broken()).body.getReader();
  assert.equal(JSON.parse(new TextDecoder().decode((await failed.read()).value)).type, 'UserV1');
  await assert.rejects(failed.read(), /TEST_PAGE_CHANGED/);
});

test('JSONL 在每个字节切点、逐字节及多行同块下保留 Unicode、空值、转义和 ACK', async () => {
  const response = syncLines(events);
  assert.equal(response.headers.get('content-type'), 'application/jsonlines+json');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.at(-1), 10);
  for (let split = 0; split <= bytes.length; split++) {
    const decoded = decodeFrozenFraming([bytes.subarray(0, split), bytes.subarray(split)]);
    assert.deepEqual(decoded.events, events);
    assert.equal(decoded.complete, true);
    assert.equal(decoded.tail, '');
  }
  assert.deepEqual(
    decodeFrozenFraming(Array.from(bytes, (byte) => Uint8Array.of(byte))).events,
    events,
  );
  assert.deepEqual(decodeFrozenFraming([bytes]).events, events);
});

test('半行 EOF 和缺失 Complete 不得被验收工具误报完成；损坏 UTF-8 拒绝', async () => {
  const bytes = new Uint8Array(await syncLines(events).arrayBuffer());
  const noNewline = decodeFrozenFraming([bytes.subarray(0, -1)]);
  assert.deepEqual(noNewline.events, events.slice(0, -1));
  assert.equal(noNewline.complete, false);
  assert.ok(noNewline.tail.length > 0);
  const prefix = new Uint8Array(await syncLines(events.slice(0, -1)).arrayBuffer());
  assert.equal(decodeFrozenFraming([prefix]).complete, false);
  assert.throws(() => decodeFrozenFraming([Uint8Array.of(0xe4, 0xb8)]), TypeError);
  assert.throws(() => decodeFrozenFraming([new TextEncoder().encode('{broken}\n')]), SyntaxError);
});

test('背压与取消：未读取不编码，取消后不编码后续事件；单次输出最多 16 KiB', async () => {
  let encoded = 0;
  const tracked = Array.from({ length: 3 }, () => ({
    type: 'AssetMetadataV1',
    ack: 'a',
    data: {
      toJSON() {
        encoded++;
        return { text: '图📷'.repeat(6000) };
      },
    },
  }));
  const reader = syncLines(tracked).body.getReader();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(encoded, 0);
  const first = await reader.read();
  assert.equal(first.value.length, 16 * 1024);
  assert.equal(encoded, 1);
  await reader.cancel();
  assert.equal((await reader.read()).done, true);
  assert.equal(encoded, 1);
  const chunks = [];
  const large = syncLines([tracked[0], events.at(-1)]).body.getReader();
  while (true) {
    const part = await large.read();
    if (part.done) break;
    chunks.push(part.value);
  }
  assert.ok(chunks.every((chunk) => chunk.length <= 16 * 1024));
  const decoded = decodeFrozenFraming(chunks);
  assert.equal(decoded.events[0].data.text, '图📷'.repeat(6000));
  assert.equal(decoded.complete, true);
});

test('空图库完成标记、reset 控制流与编码异常保持独立语义', async () => {
  const complete = events.at(-1);
  assert.equal(
    decodeFrozenFraming([new Uint8Array(await syncLines([complete]).arrayBuffer())]).complete,
    true,
  );
  const reset = { type: 'SyncResetV1', data: {}, ack: 'SyncResetV1|reset|test-epoch' };
  const decoded = decodeFrozenFraming([new Uint8Array(await syncLines([reset]).arrayBuffer())]);
  assert.deepEqual(decoded.events, [reset]);
  assert.equal(decoded.complete, false); // reset is a control response, not a completed data sync
  const failing = syncLines([
    {
      type: 'AssetV2',
      ack: 'x',
      data: {
        toJSON() {
          throw new Error('encoding failed');
        },
      },
    },
  ]);
  await assert.rejects(failing.text(), /encoding failed/);
});
