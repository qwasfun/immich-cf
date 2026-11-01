import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { getPlatformProxy, unstable_dev } from 'wrangler';
import { pairId, liveMov, liveJpeg, liveHeic } from './fixtures/live-photo-media.mjs';
import { multipartCases } from './fixtures/multipart.mjs';
let worker, platform, db, bucket;
const state = path.resolve('work', `live-photo-${crypto.randomUUID()}`);
before(async () => {
  await mkdir(state, { recursive: true });
  const require = createRequire(import.meta.url),
    cli = path.resolve(path.dirname(require.resolve('wrangler')), '../bin/wrangler.js');
  execFileSync(
    process.execPath,
    [
      cli,
      'd1',
      'migrations',
      'apply',
      'IMMICH_CF_DB',
      '--env',
      'dev',
      '--local',
      '--persist-to',
      state,
    ],
    { stdio: 'pipe' },
  );
  platform = await getPlatformProxy({
    configPath: 'wrangler.json',
    environment: 'dev',
    persist: { path: path.join(state, 'v3') },
    remoteBindings: false,
  });
  db = platform.env.IMMICH_CF_DB;
  bucket = platform.env.IMMICH_CF_MEDIA;
  worker = await unstable_dev('tests/fixtures/live-photo-worker.ts', {
    config: 'wrangler.json',
    env: 'dev',
    local: true,
    ip: '127.0.0.1',
    port: 0,
    persist: true,
    persistTo: state,
    experimental: { forceLocal: true, watch: false, disableExperimentalWarning: true },
  });
});
after(async () => {
  await worker?.stop();
  await platform?.dispose();
});
async function user() {
  await db.prepare('DELETE FROM login_buckets').run();
  const id = crypto.randomUUID(),
    email = `${id}@example.invalid`;
  await db
    .prepare(
      'INSERT INTO users(id,email,name,password_hash,created_at,update_id) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      id,
      email,
      'Live Photo',
      await bcrypt.hash('test-password', 12),
      new Date().toISOString(),
      crypto.randomUUID(),
    )
    .run();
  const r = await api('/api/auth/login', { email, password: 'test-password' });
  assert.equal(r.status, 201);
  return { id, token: (await r.json()).accessToken };
}
const api = (url, body, token, method = 'POST') =>
  worker.fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function upload(u, bytes, fields = {}, filename = 'IMG.JPG', extra = {}) {
  const form = new FormData();
  form.append('assetData', new Blob([bytes]), filename);
  form.append('fileCreatedAt', '2026-11-01T00:00:00.000Z');
  form.append('fileModifiedAt', '2026-11-01T00:00:00.000Z');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const encoded = new Request('http://localhost/api/assets', { method: 'POST', body: form });
  return worker.fetch('/api/assets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${u.token}`,
      'Content-Type': encoded.headers.get('content-type'),
      ...extra,
    },
    body: new Uint8Array(await encoded.arrayBuffer()),
  });
}
async function pair(u, format = 'jpeg', padding = 0) {
  const id = pairId(),
    motion = liveMov(id),
    photo = format === 'heic' ? liveHeic(id) : liveJpeg(id, padding);
  let r = await upload(u, motion, { visibility: 'hidden' }, 'IMG.MOV');
  assert.equal(r.status, 201, await r.clone().text());
  const video = (await r.json()).id;
  r = await upload(
    u,
    photo,
    { livePhotoVideoId: video },
    format === 'heic' ? 'IMG.HEIC' : 'IMG.JPG',
  );
  assert.equal(r.status, 201, await r.clone().text());
  return { photo, motion, id: (await r.json()).id, video };
}
test('JPEG/MOV 完整配对、>4MiB 流式上传、原件摘要、隐藏统计、播放 Range 与重复上传', async () => {
  const u = await user(),
    p = await pair(u, 'jpeg', 5 * 1024 * 1024);
  const detail = await (await api(`/api/assets/${p.id}`, undefined, u.token, 'GET')).json();
  assert.equal(detail.livePhotoVideoId, p.video);
  assert.equal(detail.type, 'IMAGE');
  const metadata = await api(
    '/api/assets/metadata',
    {
      items: [p.id, p.video].map((assetId) => ({
        assetId,
        key: 'mobile-app',
        value: { iCloudId: 'PRIVATE-CLOUD-ID' },
      })),
    },
    u.token,
    'PUT',
  );
  assert.equal(metadata.status, 404);
  assert.deepEqual((await metadata.json()).errors[0].path, ['items[1].assetId']);
  assert.equal(
    (await db.prepare('SELECT metadata FROM assets WHERE id=?').bind(p.id).first()).metadata,
    '[]',
  );
  assert.deepEqual(await (await api('/api/assets/statistics', undefined, u.token, 'GET')).json(), {
    images: 1,
    videos: 0,
    total: 1,
  });
  const row = await db.prepare('SELECT * FROM assets WHERE id=?').bind(p.id).first();
  assert.equal((await bucket.head(row.object_key)).size, p.photo.length);
  const video = await worker.fetch(`/api/assets/${p.video}/video/playback`, {
    headers: { Authorization: `Bearer ${u.token}`, Range: 'bytes=0-15' },
  });
  assert.equal(video.status, 206);
  assert.deepEqual(Buffer.from(await video.arrayBuffer()), p.motion.subarray(0, 16));
  const duplicate = await upload(u, p.photo, { livePhotoVideoId: p.video });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).id, p.id);
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) n FROM logical_asset_slots WHERE owner_id=?')
        .bind(u.id)
        .first()
    ).n,
    1,
  );
});
test('HEIC 原件先保存；免费额度耗尽、故障、额度恢复后生成并复用两份预览', async () => {
  const u = await user(),
    p = await pair(u, 'heic');
  let r = await worker.fetch(`/api/assets/${p.id}/thumbnail?size=preview`, {
    headers: { Authorization: `Bearer ${u.token}`, 'x-test-images': 'unconfirmed' },
  });
  assert.equal(r.status, 503);
  assert.match((await r.json()).message, /原件已保存/);
  await worker.fetch('/__test/previews', { headers: { 'x-test-images': 'quota' } });
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM media_previews WHERE status='quota'").first()).n,
    2,
  );
  assert.equal((await api(`/api/assets/${p.id}/original`, undefined, u.token, 'GET')).status, 200);
  await db.prepare('DELETE FROM image_transform_budget').run();
  await db.prepare('UPDATE media_previews SET next_try_ms=0').run();
  await worker.fetch('/__test/previews', { headers: { 'x-test-images': 'failure' } });
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM media_previews WHERE status='failed'").first()).n,
    2,
  );
  await db.prepare('UPDATE media_previews SET next_try_ms=0').run();
  assert.equal((await (await worker.fetch('/__test/previews')).json()).processed, 2);
  assert.equal(
    (await api(`/api/assets/${p.id}/thumbnail?size=preview`, undefined, u.token, 'GET')).status,
    200,
  );
  assert.equal(
    (
      await (
        await worker.fetch('/__test/previews', { headers: { 'x-test-images': 'quota' } })
      ).json()
    ).processed,
    0,
  );
});
test('未配对照片、错误/越权/删除视频及校验和不符明确失败，不产生时间线假成功', async () => {
  const a = await user(),
    b = await user(),
    id = pairId();
  let r = await upload(a, liveJpeg(id));
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /livePhotoVideoId/);
  r = await upload(b, liveMov(id), { visibility: 'hidden' }, 'IMG.MOV');
  const video = (await r.json()).id;
  assert.equal((await upload(a, liveJpeg(id), { livePhotoVideoId: video })).status, 400);
  r = await upload(a, liveMov(id), { visibility: 'hidden' }, 'IMG.MOV');
  const own = (await r.json()).id;
  assert.equal((await upload(a, liveJpeg(pairId()), { livePhotoVideoId: own })).status, 400);
  assert.equal(
    (
      await upload(a, liveJpeg(id), { livePhotoVideoId: own }, 'IMG.JPG', {
        'x-immich-checksum': 'a'.repeat(40),
      })
    ).status,
    400,
  );
  await api('/api/assets', { ids: [own] }, a.token, 'DELETE');
  assert.equal((await upload(a, liveJpeg(id), { livePhotoVideoId: own })).status, 400);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM assets WHERE owner_id=? AND visibility='timeline'")
        .bind(a.id)
        .first()
    ).n,
    0,
  );
});
test('原件异常时预检查允许重传；照片重传不能绕过缺失动态原件', async () => {
  const u = await user(),
    p = await pair(u);
  const row = await db.prepare('SELECT * FROM assets WHERE id=?').bind(p.video).first();
  await bucket.delete(row.object_key);
  const photo = await db.prepare('SELECT checksum FROM assets WHERE id=?').bind(p.id).first();
  const check = await api(
    '/api/assets/bulk-upload-check',
    { assets: [{ id: 'local', checksum: photo.checksum }] },
    u.token,
  );
  assert.equal((await check.json()).results[0].action, 'accept');
  assert.equal((await upload(u, p.photo, { livePhotoVideoId: p.video })).status, 409);
  assert.equal((await upload(u, p.motion, { visibility: 'hidden' }, 'IMG.MOV')).status, 200);
  assert.equal((await upload(u, p.photo, { livePhotoVideoId: p.video })).status, 200);
});
test('整组回收/恢复、隐藏视频禁止入相册，账号导出 v2 包含两份原件', async () => {
  const u = await user(),
    p = await pair(u, 'heic');
  await db.prepare('INSERT INTO operations_admins(user_id) VALUES(?)').bind(u.id).run();
  let r = await api('/api/albums', { albumName: 'invalid', assetIds: [p.video] }, u.token);
  assert.notEqual(r.status, 201);
  await api('/api/assets', { ids: [p.id] }, u.token, 'DELETE');
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=? AND deleted_at IS NOT NULL')
        .bind(u.id)
        .first()
    ).n,
    2,
  );
  r = await api('/api/trash/restore/assets', { ids: [p.id] }, u.token);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).count, 1);
  const manifest = await (
    await api(`/api/immich-cf/admin/export?userId=${u.id}`, undefined, u.token, 'GET')
  ).json();
  assert.equal(manifest.format, 'immich-cf-account-v2');
  assert.equal(manifest.assets.length, 2);
  for (const asset of manifest.assets) {
    const raw = await api(asset.downloadPath, undefined, u.token, 'GET');
    assert.equal(raw.status, 200);
    assert.equal((await raw.arrayBuffer()).byteLength, asset.bytes);
  }
});

test('照片 20,000,000 字节边界，超限拒绝且不发布半组资产', async () => {
  const u = await user(),
    id = pairId();
  const motion = await upload(u, liveMov(id), { visibility: 'hidden' }, 'IMG.MOV');
  const video = (await motion.json()).id;
  const base = liveJpeg(id).length;
  assert.equal(
    (await upload(u, liveJpeg(id, 20_000_001 - base), { livePhotoVideoId: video })).status,
    413,
  );
  assert.equal(
    (await upload(u, liveJpeg(id, 20_000_000 - base), { livePhotoVideoId: video })).status,
    201,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM media_upload_staging WHERE owner_id=? AND status<>'deleted'",
        )
        .bind(u.id)
        .first()
    ).n,
    0,
  );
});
test('动态视频 64 MiB 边界，超限中止 multipart，原件与同步不误发布', async () => {
  const u = await user(),
    id = pairId(),
    base = liveMov(id, 0).length;
  assert.equal(
    (await upload(u, liveMov(id, 64 * 1024 * 1024 + 1 - base), { visibility: 'hidden' }, 'IMG.MOV'))
      .status,
    413,
  );
  const r = await upload(
    u,
    liveMov(id, 64 * 1024 * 1024 - base),
    { visibility: 'hidden' },
    'IMG.MOV',
  );
  assert.equal(r.status, 201, await r.clone().text());
  assert.equal(
    (await upload(u, liveJpeg(id), { livePhotoVideoId: (await r.json()).id })).status,
    201,
  );
});
test('新流式解析保持表单 EOF、字段、额外文件和 PNG 结构保护，失败后可继续备份', async () => {
  const u = await user(),
    corpus = await multipartCases();
  for (const sample of [...corpus.invalid].sort((a, b) =>
    a.name === 'closing-truncated' ? -1 : b.name === 'closing-truncated' ? 1 : 0,
  )) {
    const r = await fetch('http://' + worker.address + ':' + worker.port + '/api/assets', {
      method: 'POST',
      headers: {
        Connection: 'close',
        Authorization: `Bearer ${u.token}`,
        'x-test-multipart-split': 'true',
        'Content-Type': corpus.type,
      },
      body: sample.body,
    });
    assert.equal(r.status, 400, sample.name + ': ' + (await r.clone().text()));
    assert.ok((await r.json()).errors?.length);
  }
  const r = await fetch('http://' + worker.address + ':' + worker.port + '/api/assets', {
    method: 'POST',
    headers: {
      Connection: 'close',
      Authorization: `Bearer ${u.token}`,
      'x-test-multipart-split': 'true',
      'Content-Type': corpus.type,
    },
    body: corpus.valid,
  });
  assert.equal(r.status, 201, await r.clone().text());
  for (const bytes of [
    liveMov(pairId()).subarray(0, 70),
    liveHeic(pairId()).subarray(0, 100),
    Buffer.from('not media'),
  ])
    assert.equal((await upload(u, bytes)).status, 400);
});
test('最后一个逻辑名额并发争用，动态和照片合计一项，满额仍可重复恢复', async () => {
  const u = await user();
  await db.batch(
    Array.from({ length: 19 }, (_, i) =>
      db
        .prepare(
          `INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES(?,?,?,?,?,'image/png',1,1,1,?,?,?,0)`,
        )
        .bind(
          crypto.randomUUID(),
          u.id,
          `seed-${i}`,
          `${u.id}/seed-${i}/original`,
          'seed.png',
          'date',
          'date',
          'date',
        ),
    ),
  );
  const ids = [pairId(), pairId()],
    responses = await Promise.all(
      ids.map((id) => upload(u, liveMov(id), { visibility: 'hidden' }, 'IMG.MOV')),
    );
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const winner = responses.findIndex((r) => r.status === 201),
    video = (await responses[winner].json()).id,
    photo = liveJpeg(ids[winner]);
  assert.equal((await upload(u, photo, { livePhotoVideoId: video })).status, 201);
  assert.equal((await upload(u, photo, { livePhotoVideoId: video })).status, 200);
  const losingPhoto = await upload(u, liveJpeg(ids[1 - winner]));
  assert.equal(losingPhoto.status, 409);
  const cause = await losingPhoto.json();
  assert.deepEqual(cause.errors[0].path, ['assetData']);
  assert.match(cause.message, /20.*回收站.*动态视频.*释放名额/);
  assert.equal((await upload(u, photo)).status, 400); // An existing slot still requires its video ID.
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) n FROM logical_asset_slots WHERE owner_id=?')
        .bind(u.id)
        .first()
    ).n,
    20,
  );
});
test('双会话同步、ACK/reset 重放保持隐藏视频及配对；永久删除有界清理预览和两份原件', async () => {
  const u = await user(),
    p = await pair(u, 'heic');
  await worker.fetch(`/__test/previews?id=${p.id}`);
  const login = await api('/api/auth/login', {
      email: `${u.id}@example.invalid`,
      password: 'test-password',
    }),
    other = (await login.json()).accessToken;
  const stream = async (token) => {
    const r = await api('/api/sync/stream', { types: ['AssetsV2'] }, token);
    assert.equal(r.status, 200);
    return (await r.text()).trim().split('\n').map(JSON.parse);
  };
  for (const token of [u.token, other]) {
    const events = await stream(token);
    assert.equal(
      events.find((e) => e.type === 'AssetV2' && e.data.id === p.id).data.livePhotoVideoId,
      p.video,
    );
    assert.equal(
      events.find((e) => e.type === 'AssetV2' && e.data.id === p.video).data.visibility,
      'hidden',
    );
    assert.equal(
      (await api('/api/sync/ack', { acks: events.map((e) => e.ack) }, token)).status,
      204,
    );
  }
  await api('/api/sync/ack', { types: ['AssetV2'] }, other, 'DELETE');
  assert.equal((await stream(other)).filter((e) => e.type === 'AssetV2').length, 2);
  const keys = (
    await db
      .prepare(
        'SELECT object_key FROM assets WHERE owner_id=? UNION SELECT object_key FROM media_previews WHERE owner_id=?',
      )
      .bind(u.id, u.id)
      .all()
  ).results.map((r) => r.object_key);
  assert.equal(
    (await api('/api/assets', { ids: [p.id], force: true }, u.token, 'DELETE')).status,
    204,
  );
  // The existing consumer deletes at most two objects per asset per pass.
  for (let i = 0; i < 3; i++) await api('/api/immich-cf/purge-run', {}, u.token);
  for (const key of keys) assert.equal(await bucket.head(key), null);
  const events = await stream(u.token);
  assert.equal(events.filter((e) => e.type === 'AssetDeleteV1').length, 2);
});
test('官方公开 HEIC 样本真实容器解析（私有本机缓存，不替代 iPhone Live Photo 验收）', async (t) => {
  let bytes;
  try {
    bytes = await readFile('work/official-IMG_2682.heic');
  } catch {
    t.skip('未下载公开样本');
    return;
  }
  assert.equal(
    createHash('sha1')
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest('hex'),
    '85cdc07c925bbcd9b35001046d8f5a4c5c72870d',
  );
  await bucket.put('public-corpus/heic', bytes);
  const r = await worker.fetch('/__test/inspect?key=public-corpus/heic');
  assert.equal(r.status, 200, await r.clone().text());
  const info = await r.json();
  assert.equal(info.mime, 'image/heic');
  assert.ok(info.width > 1000 && info.height > 1000);
});
test('同一配对不同字节并发不能产生额外原件/预约，配对标识大小写不能混淆', async () => {
  const u = await user(),
    id = pairId(),
    results = await Promise.all(
      [16, 17].map((n) => upload(u, liveMov(id, n), { visibility: 'hidden' }, 'IMG.MOV')),
    );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  const video = (await results.find((r) => r.status === 201).json()).id;
  assert.equal((await upload(u, liveMov(id, 18), { visibility: 'hidden' }, 'IMG.MOV')).status, 400);
  assert.equal(
    (await upload(u, liveJpeg(id.toUpperCase()), { livePhotoVideoId: video })).status,
    400,
  );
  assert.equal((await upload(u, liveJpeg(id), { livePhotoVideoId: video })).status, 201);
  assert.equal((await upload(u, liveJpeg(id, 1), { livePhotoVideoId: video })).status, 400);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM upload_intents WHERE owner_id=?').bind(u.id).first())
      .n,
    0,
  );
  assert.equal((await bucket.list({ prefix: u.id + '/' })).objects.length, 2);
});
test('真实公开 HEIC/MOV 配对兼容 QuickTime 非 FullBox 元数据（不替代真机验收）', async (t) => {
  const groups = [
    ['55283ed0a638cd0088a6ae88e842163573ea4a59', '41ff48524ff39280dafd871cded1c8b5a9b106b9'],
    ['3072131423bd8bb078319db364954ead817ebb84', '436f6e70400ab276bc57b8544be5c19836435a93'],
  ];
  for (let i = 0; i < groups.length; i++) {
    let photo, motion;
    try {
      [photo, motion] = await Promise.all(
        ['heic', 'mov'].map((ext) => readFile(`work/public-live-${i + 1}.${ext}`)),
      );
    } catch {
      t.skip('未下载公开完整配对');
      return;
    }
    for (const [j, bytes] of [photo, motion].entries())
      assert.equal(
        createHash('sha1')
          .update(Buffer.from(`blob ${bytes.length}\0`))
          .update(bytes)
          .digest('hex'),
        groups[i][j],
      );
    const u = await user();
    let r = await upload(u, motion, { visibility: 'hidden' }, 'PUBLIC.MOV');
    assert.equal(r.status, 201, await r.clone().text());
    const video = (await r.json()).id;
    r = await upload(u, photo, { livePhotoVideoId: video }, 'PUBLIC.HEIC');
    assert.equal(r.status, 201, await r.clone().text());
  }
});
test('重启遗留 multipart 有持久编号可中止，清理不能越过原件引用隔离', async () => {
  const u = await user(),
    id = crypto.randomUUID(),
    key = `${u.id}/staging/${id}`,
    mpu = await bucket.createMultipartUpload(key);
  await mpu.uploadPart(1, new Uint8Array(5 * 1024 * 1024));
  await db
    .prepare(
      'INSERT INTO media_upload_staging(id,owner_id,object_key,expires_ms,multipart_id) VALUES(?,?,?,?,?)',
    )
    .bind(id, u.id, key, 0, mpu.uploadId)
    .run();
  assert.equal((await worker.fetch('/__test/clean-staging')).status, 200);
  assert.equal(
    (await db.prepare('SELECT status FROM media_upload_staging WHERE id=?').bind(id).first())
      .status,
    'deleted',
  );
  await assert.rejects(mpu.uploadPart(2, new Uint8Array(1)));
  await assert.rejects(
    db
      .prepare(
        'INSERT INTO upload_intents(owner_id,checksum,id,object_key,created_at) VALUES(?,?,?,?,?)',
      )
      .bind(u.id, 'fenced', crypto.randomUUID(), key, 'date')
      .run(),
    /STAGING_FENCED/,
  );
});
