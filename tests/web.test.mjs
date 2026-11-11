import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { getPlatformProxy, unstable_dev } from 'wrangler';
import { liveJpeg, liveMov, liveHeic, pairId } from './fixtures/live-photo-media.mjs';
import { photoJpeg, photoTiff, pngWithExif } from './fixtures/photo-metadata.mjs';

const state = path.resolve('work', `web-v1-${randomUUID()}`),
  root = '/api/immich-cf/web',
  adminRoot = '/api/immich-cf/admin/users';
const password = 'web-v1-test-private-password';
let worker, platform, db, bucket, passwordHash, origin;
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
  passwordHash = await bcrypt.hash(password, 12);
  worker = await unstable_dev('tests/fixtures/web-worker.ts', {
    config: 'wrangler.json',
    env: 'dev',
    local: true,
    ip: '127.0.0.1',
    port: 0,
    persist: true,
    persistTo: state,
    experimental: { forceLocal: true, watch: false, disableExperimentalWarning: true },
  });
  origin = await (await worker.fetch('/__test/origin')).text();
});
after(async () => {
  await worker?.stop();
  await platform?.dispose();
});
async function user(operator = false) {
  const id = randomUUID(),
    token = randomBytes(32).toString('hex'),
    email = id + '@example.invalid';
  await db
    .prepare(
      'INSERT INTO users(id,email,name,password_hash,created_at,update_id) VALUES(?,?,?,?,?,?)',
    )
    .bind(id, email, '网页测试', passwordHash, new Date().toISOString(), randomUUID())
    .run();
  const sessionId = randomUUID();
  await db
    .prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)')
    .bind(sessionId, id, createHash('sha256').update(token).digest('hex'), Date.now() + 3600000)
    .run();
  if (operator) await db.prepare('INSERT INTO operations_admins VALUES(?)').bind(id).run();
  return { id, token, email, sessionId };
}
const call = (route, u, method = 'GET', body, extra = {}) =>
  worker.fetch(route, {
    method,
    headers: {
      ...(u ? { Authorization: `Bearer ${u.token}` } : {}),
      Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function seed(u, content = liveJpeg(pairId()), mime = 'image/jpeg', fields = {}) {
  const id = fields.id ?? randomUUID(),
    key = `${u.id}/${id}`,
    checksum = createHash('sha1').update(content).digest('base64');
  await bucket.put(key, content, { sha1: createHash('sha1').update(content).digest() });
  await db
    .prepare(
      `INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite,r2_sha1_verified,media_type,visibility,pair_id,logical_key,live_photo_video_id)
    VALUES(?,?,?,?,?,?,?,64,48,?,?,?,0,1,?,?,?,?,?)`,
    )
    .bind(
      id,
      u.id,
      checksum,
      key,
      fields.filename ??
        'private-photo.' + (mime === 'image/heic' ? 'heic' : mime === 'image/png' ? 'png' : 'jpg'),
      mime,
      content.length,
      new Date().toISOString(),
      fields.date ?? '2026-11-02T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      fields.type ?? 'IMAGE',
      fields.visibility ?? 'timeline',
      fields.pair ?? null,
      fields.pair ? 'live:' + fields.pair : '',
      fields.video ?? null,
    )
    .run();
  return { id, content, key };
}
test('照片资料提取相机、GPS和原件日期，旧照片时间及原件字节和 App 标识保持', async () => {
  const u = await user(),
    foreign = await user(),
    photo = await seed(u, photoJpeg());
  const opaque = JSON.stringify([
    { key: 'mobile-app', value: { iCloudId: 'private-cloud-id', location: { test: true } } },
  ]);
  await db.prepare('UPDATE assets SET metadata=? WHERE id=?').bind(opaque, photo.id).run();
  const route = `${root}/assets/${photo.id}/metadata`,
    before = await (await call(route, u)).json();
  assert.equal(before.extracted, false);
  const read = await call(route + '/extract', u, 'POST', { version: before.version });
  assert.equal(read.status, 200);
  const data = await read.json();
  assert.equal(data.make, 'Example Camera');
  assert.equal(data.model, 'Test Model');
  assert.equal(data.iso, 200);
  assert.equal(data.latitude, 31.2083333);
  assert.equal(data.longitude, 121.5);
  assert.equal(data.source.originalDateTime, '2020-01-01T00:30:00.125');
  assert.equal(data.source.originalOffset, '+08:00');
  assert.equal(data.fileCreatedAt, before.fileCreatedAt);
  assert.doesNotMatch(JSON.stringify(data), /object_key|iCloudId|private-cloud-id|checksum|token/);
  assert.equal(
    (await db.prepare('SELECT metadata FROM assets WHERE id=?').bind(photo.id).first()).metadata,
    opaque,
  );
  assert.equal((await call(route, foreign)).status, 404);
  assert.equal((await call(route, null)).status, 401);
  assert.equal(
    (
      await call(
        route + '/extract',
        u,
        'POST',
        { version: data.version },
        { Origin: 'https://foreign.invalid' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(root + '/photo-metadata', u, 'PATCH', {
        ids: [photo.id],
        version: data.version,
        description: '手动说明',
        latitude: null,
        longitude: null,
      })
    ).status,
    200,
  );
  const updated = await (await call(route, u)).json();
  const repeat = await (
    await call(route + '/extract', u, 'POST', { version: updated.version })
  ).json();
  assert.equal(repeat.description, '手动说明');
  assert.equal(repeat.latitude, null);
  assert.equal(repeat.longitude, null);
  const original = await bucket.get(photo.key);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), photo.content);
});

test('照片资料修改同步官方 EXIF 与本地拍摄时间，重定位跟随改时照片且游标失效', async () => {
  const u = await user(),
    livePair = pairId(),
    motion = await seed(u, liveMov(livePair), 'video/quicktime', {
      type: 'VIDEO',
      visibility: 'hidden',
      pair: livePair,
    }),
    photo = await seed(u, photoJpeg({ pair: livePair }), 'image/jpeg', {
      pair: livePair,
      video: motion.id,
    }),
    other = await seed(u, photoJpeg({ local: '2021:01:01 12:00:00' }));
  const album = await (
    await call('/api/albums', u, 'POST', { albumName: '资料同步', assetIds: [photo.id] })
  ).json();
  const route = `${root}/assets/${photo.id}/metadata`,
    prior = await (await call(route, u)).json();
  const oldPage = await (await call(root + '/assets?limit=1', u)).json();
  const r = await call(root + '/photo-metadata', u, 'PATCH', {
    ids: [photo.id],
    version: prior.version,
    description: '新描述',
    latitude: 0,
    longitude: 0,
    dateTime: '2020-01-01T00:30:00.125',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(r.status, 200);
  const updated = await (await call('/api/assets/' + photo.id, u)).json();
  assert.equal(updated.fileCreatedAt, '2019-12-31T16:30:00.125Z');
  assert.equal(updated.localDateTime, '2020-01-01T00:30:00.125Z');
  assert.equal(updated.livePhotoVideoId, motion.id);
  assert.equal(updated.exifInfo.description, '新描述');
  assert.equal(updated.exifInfo.latitude, 0);
  assert.equal(updated.exifInfo.timeZone, 'Asia/Shanghai');
  const seek = await (
    await call(
      root +
        '/assets?anchorTime=' +
        encodeURIComponent(prior.fileCreatedAt) +
        '&anchorId=' +
        photo.id,
      u,
    )
  ).json();
  assert.equal(seek.items[0].id, photo.id);
  assert.equal((await call(root + '/assets?cursor=' + oldPage.nextCursor, u)).status, 409);
  const syncResponse = await call('/api/sync/stream', u, 'POST', {
    types: ['AssetsV2', 'AssetExifsV1', 'AlbumAssetsV2', 'AlbumAssetExifsV1'],
    reset: true,
  });
  assert.equal(syncResponse.status, 200);
  const events = (await syncResponse.text()).trim().split('\n').map(JSON.parse);
  const exif = events.find((e) => e.type === 'AssetExifV1' && e.data.assetId === photo.id);
  assert.ok(
    events.findIndex((e) => e.type === 'AssetV2' && e.data.id === photo.id) < events.indexOf(exif),
  );
  assert.ok(
    events.some((e) => e.type === 'AlbumAssetCreateV2' && e.data.id === photo.id) &&
      events.findIndex((e) => e.type === 'AlbumAssetCreateV2' && e.data.id === photo.id) <
        events.findIndex((e) => e.type === 'AlbumAssetExifCreateV1' && e.data.assetId === photo.id),
  );
  assert.equal(exif.data.description, '新描述');
  assert.equal(exif.data.dateTimeOriginal, updated.fileCreatedAt);
  assert.equal(exif.data.timeZone, 'Asia/Shanghai');
  assert.ok(events.some((e) => e.type === 'AlbumAssetExifCreateV1' && e.data.assetId === photo.id));
  const spec = JSON.parse(
    await readFile('docs/contracts/upstream/immich-v3.3.1.openapi.json', 'utf8'),
  ).components.schemas.SyncAssetExifV1;
  for (const key of spec.required) assert.ok(Object.hasOwn(exif.data, key), key);
  assert.equal(events.at(-1).type, 'SyncCompleteV1');
  assert.equal(
    (await call('/api/sync/ack', u, 'POST', { acks: events.map((e) => e.ack) })).status,
    204,
  );
  const current = await (await call(route, u)).json();
  assert.equal(
    (
      await call(root + '/photo-metadata', u, 'PATCH', {
        ids: [photo.id, other.id],
        version: current.version,
        shiftMinutes: -60,
      })
    ).status,
    200,
  );
  const delta = await (
    await call('/api/sync/stream', u, 'POST', {
      types: ['AssetsV2', 'AssetExifsV1', 'AlbumAssetExifsV1'],
    })
  ).text();
  assert.match(delta, /AlbumAssetExifUpdateV1/);
  assert.match(delta, /2019-12-31T15:30:00.125Z/);
  assert.equal((await (await call('/api/albums/' + album.id, u)).json()).assetCount, 1);
  const original = await call(`${root}/assets/${photo.id}/download`, u);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), photo.content);
  const originalMotion = await call(`${root}/assets/${photo.id}/download?component=motion`, u);
  assert.deepEqual(Buffer.from(await originalMotion.arrayBuffer()), motion.content);
});

test('照片资料批量时间修正保留间隔，字段错误、过期版本、账号和事务中撤销均不部分写入', async () => {
  const u = await user(),
    foreign = await user(),
    a = await seed(u, photoJpeg(), 'image/jpeg', { date: '2026-01-01T00:00:00.125Z' }),
    b = await seed(u, photoJpeg({ local: '2022:01:01 00:00:00' }), 'image/jpeg', {
      date: '2026-01-01T01:20:00.500Z',
    }),
    f = await seed(foreign);
  const get = async () => await (await call(`${root}/assets/${a.id}/metadata`, u)).json();
  const before = await get(),
    patch = { ids: [a.id, b.id], version: before.version, shiftMinutes: 480 };
  assert.equal((await call(root + '/photo-metadata', u, 'PATCH', patch)).status, 200);
  const [one, two] = await Promise.all([
    db.prepare('SELECT file_created_at FROM assets WHERE id=?').bind(a.id).first(),
    db.prepare('SELECT file_created_at FROM assets WHERE id=?').bind(b.id).first(),
  ]);
  assert.equal(one.file_created_at, '2026-01-01T08:00:00.125Z');
  assert.equal(Date.parse(two.file_created_at) - Date.parse(one.file_created_at), 80 * 60000 + 375);
  assert.equal((await call(root + '/photo-metadata', u, 'PATCH', patch)).status, 409);
  const current = await get();
  for (const [extra, field] of [
    [{ latitude: 20 }, 'latitude/longitude'],
    [{ latitude: 91, longitude: 0 }, 'latitude'],
    [{ dateTime: '2026-03-08T02:30', timeZone: 'America/Los_Angeles' }, 'dateTime/timeZone'],
    [{ dateTime: '2026-02-30T00:00', timeZone: 'UTC' }, 'dateTime'],
    [{ timeZone: 'bad-zone' }, 'timeZone'],
    [{ shiftMinutes: 0 }, 'shiftMinutes'],
    [{ description: 'x'.repeat(2001) }, 'description'],
  ]) {
    const response = await call(root + '/photo-metadata', u, 'PATCH', {
      ids: [a.id, b.id],
      version: current.version,
      ...extra,
    });
    assert.equal(response.status, 400);
    assert.deepEqual((await response.json()).errors[0].path, [field]);
  }
  assert.equal(
    (
      await call(root + '/photo-metadata', u, 'PATCH', {
        ids: [a.id, f.id],
        version: current.version,
        shiftMinutes: 10,
      })
    ).status,
    404,
  );
  const unchanged = await get();
  assert.equal(unchanged.fileCreatedAt, one.file_created_at);
  assert.equal(unchanged.version, current.version);
  const revoke = await call(
    root + '/photo-metadata',
    u,
    'PATCH',
    { ids: [a.id, b.id], version: current.version, shiftMinutes: 10 },
    { 'x-test-revoke-photo-session': u.sessionId },
  );
  assert.equal(revoke.status, 401);
  assert.equal(
    (await db.prepare('SELECT file_created_at FROM assets WHERE id=?').bind(a.id).first())
      .file_created_at,
    one.file_created_at,
  );
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM web_photo_guards').first()).n, 0);
});

test('照片资料新 Web 上传优先 EXIF 时间，JPEG/PNG/HEIC 提取一致，无偏移使用浏览器时区，原生上传尊重提交时间', async () => {
  const u = await user();
  const send = async (content, name, route = root + '/upload', zone = 'Asia/Shanghai') => {
    const form = new FormData();
    form.append('assetData', new File([content], name));
    form.append('fileCreatedAt', '2026-11-11T00:00:00.000Z');
    form.append('fileModifiedAt', '2026-11-10T00:00:00.000Z');
    const encoded = new Request('http://localhost', { method: 'POST', body: form });
    const response = await worker.fetch(route, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + u.token,
        Origin: origin,
        'x-immich-cf-time-zone': zone,
        'Content-Type': encoded.headers.get('content-type'),
      },
      body: await encoded.arrayBuffer(),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).id;
  };
  const png = pngWithExif(await readFile('tests/fixtures/small.png'));
  for (const [bytes, name] of [
    [photoJpeg(), 'meta.jpg'],
    [png, 'meta.png'],
    [liveHeic('unused', photoTiff()), 'meta.heic'],
  ]) {
    const id = await send(bytes, name),
      data = await (await call(`${root}/assets/${id}/metadata`, u)).json();
    assert.equal(data.fileCreatedAt, '2019-12-31T16:30:00.125Z');
    assert.equal(data.fileModifiedAt, '2026-11-10T00:00:00.000Z');
    assert.equal(data.timeSource, 'exif');
    assert.equal(data.iso, 200);
    assert.equal(data.latitude, 31.2083333);
  }
  const noOffset = await send(
    photoJpeg({ offset: null }),
    'no-zone.jpg',
    root + '/upload',
    'America/Los_Angeles',
  );
  assert.equal(
    (await (await call(`${root}/assets/${noOffset}/metadata`, u)).json()).fileCreatedAt,
    '2020-01-01T08:30:00.125Z',
  );
  const native = await send(
    photoJpeg({ local: '2023:01:01 12:00:00' }),
    'native.jpg',
    '/api/assets',
  );
  assert.equal(
    (await (await call(`${root}/assets/${native}/metadata`, u)).json()).fileCreatedAt,
    '2026-11-11T00:00:00.000Z',
  );
});

test('照片资料批量修正覆盖 1000 项，未选项目不变，超过上限拒绝且可按修改后时间定位', async () => {
  const u = await user(),
    ids = Array.from({ length: 1001 }, () => randomUUID()),
    start = Date.parse('2024-01-01T00:00:00.125Z');
  for (let at = 0; at < ids.length; at += 40)
    await db.batch(
      ids
        .slice(at, at + 40)
        .map((id, n) =>
          db
            .prepare(
              "INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES(?,?,?,?,?,'image/jpeg',4,1,1,?,?,?,0)",
            )
            .bind(
              id,
              u.id,
              id,
              u.id + '/' + id,
              'bulk-time.jpg',
              new Date(start).toISOString(),
              new Date(start + (at + n) * 1000).toISOString(),
              new Date(start).toISOString(),
            ),
        ),
    );
  const original = await (await call(`${root}/assets/${ids[0]}/metadata`, u)).json();
  const response = await call(root + '/photo-metadata', u, 'PATCH', {
    ids: ids.slice(0, 1000),
    version: original.version,
    shiftMinutes: 90,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, 1000);
  const aggregate = await db
    .prepare(
      "SELECT COUNT(*) n,MIN(file_created_at) first,MAX(file_created_at) last FROM assets WHERE owner_id=? AND photo_metadata<>'{}'",
    )
    .bind(u.id)
    .first();
  assert.equal(aggregate.n, 1000);
  assert.equal(aggregate.first, '2024-01-01T01:30:00.125Z');
  assert.equal(aggregate.last, '2024-01-01T01:46:39.125Z');
  const untouched = await (await call(`${root}/assets/${ids[1000]}/metadata`, u)).json();
  assert.equal(untouched.fileCreatedAt, '2024-01-01T00:16:40.125Z');
  assert.equal(
    (
      await call(root + '/photo-metadata', u, 'PATCH', {
        ids,
        version: untouched.version,
        shiftMinutes: 10,
      })
    ).status,
    400,
  );
  const seek = await (
    await call(
      root +
        '/assets?anchorId=' +
        ids[0] +
        '&anchorTime=' +
        encodeURIComponent(original.fileCreatedAt),
      u,
    )
  ).json();
  assert.equal(seek.items[0].id, ids[0]);
});

test('网页入口与深链接可用，API/未知路径不回落 HTML，未登录数据私有', async () => {
  for (const route of [
    '/',
    '/photos',
    '/archive',
    '/albums',
    '/account',
    '/admin/users',
    '/share',
    '/shares',
  ]) {
    const r = await call(route);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /html/);
    assert.match(await r.text(), /lang="zh-CN"/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    if (route.startsWith('/share')) {
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.match(r.headers.get('x-robots-tag'), /noindex/);
    }
  }
  const unknown = await call('/api/unknown');
  assert.equal(unknown.status, 501);
  assert.match(unknown.headers.get('content-type'), /json/);
  assert.equal((await call('/unknown')).status, 404);
  assert.equal((await call('/assets/missing-file.js')).status, 404);
  const r = await call(root + '/bootstrap');
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await call(root + '/wrong/bootstrap')).status, 404);
});
test('初始化权限独立于官方 isAdmin，名额来自服务端且无密码/令牌泄露', async () => {
  const u = await user(true),
    r = await call(root + '/bootstrap', u),
    data = await r.json();
  assert.equal(data.canManageAccounts, true);
  assert.equal(data.limits.assetLimit, 10000);
  assert.equal(data.support.upload, true);
  assert.equal(data.support.share, true);
  assert.equal(data.limits.upload.photoBytes, 20_000_000);
  assert.equal(data.limits.upload.motionBytes, 64 * 1024 ** 2);
  assert.equal(data.user.id, u.id);
  assert.doesNotMatch(JSON.stringify(data), /password_hash|token_hash|object_key/);
  assert.equal((await (await call('/api/users/me', u)).json()).isAdmin, false);
});

const shares = root + '/shares';
const shared = root + '/shared';
const previewOf = (id) => `${shared}/assets/${id}/preview`;
const originalOf = (id, component = 'photo') =>
  `${shared}/assets/${id}/download?component=${component}`;
const shareAuth = (link) => ({ Authorization: 'Share ' + link.path.split('#')[1] });

test('所选照片分享只开放指定预览，令牌只在创建时返回，撤销后访客无法继续读取', async () => {
  const owner = await user(),
    foreign = await user(true);
  const first = await seed(owner),
    unshared = await seed(owner),
    other = await seed(foreign);
  const input = { ids: [first.id], days: 7 };
  assert.equal((await call(shares, null, 'POST', input)).status, 401);
  assert.equal(
    (await call(shares, owner, 'POST', input, { Origin: 'https://foreign.invalid' })).status,
    403,
  );
  const foreignSelection = await call(shares, owner, 'POST', {
    ids: [first.id, other.id],
    days: 7,
  });
  assert.equal(foreignSelection.status, 404);
  assert.deepEqual((await foreignSelection.json()).errors[0].path, ['ids']);
  for (const [data, field] of [
    [{ ids: [], days: 7 }, 'ids'],
    [{ ids: [first.id, first.id], days: 7 }, 'ids'],
    [{ ids: [first.id], days: 0 }, 'days'],
    [{ ids: [first.id], albumId: randomUUID(), days: 7 }, 'ids/albumId'],
  ]) {
    const r = await call(shares, owner, 'POST', data);
    assert.equal(r.status, 400);
    assert.deepEqual((await r.json()).errors[0].path, [field]);
  }
  const created = await call(shares, owner, 'POST', input);
  assert.equal(created.status, 201);
  const link = await created.json();
  assert.match(link.path, /^\/share#[a-f0-9]{64}$/);
  const key = link.path.split('#')[1];
  const stored = await db
    .prepare('SELECT token_hash FROM web_shares WHERE id=?')
    .bind(link.id)
    .first();
  assert.equal(stored.token_hash, createHash('sha256').update(key).digest('hex'));
  const ownerList = await (await call(shares, owner)).json();
  assert.deepEqual(
    ownerList.items.map((item) => item.id),
    [link.id],
  );
  assert.ok(!JSON.stringify(ownerList).includes(key));
  assert.equal((await (await call(shares, foreign)).json()).items.length, 0);
  assert.equal((await call(`${shares}/${link.id}`, foreign, 'DELETE')).status, 404);
  assert.equal((await call(shared, owner)).status, 404);

  const headers = shareAuth(link);
  const page = await call(shared, null, 'GET', undefined, headers);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const data = await page.json();
  assert.deepEqual(data.items, [{ id: first.id }]);
  assert.deepEqual(Object.keys(data).sort(), [
    'allowDownload',
    'expiresAt',
    'items',
    'nextCursor',
    'title',
  ]);
  assert.equal(data.allowDownload, false);
  assert.equal((await call(originalOf(first.id), null, 'GET', undefined, headers)).status, 403);
  const jpeg = await call(previewOf(first.id), null, 'GET', undefined, {
    ...headers,
    'x-test-sync-preview': '1',
  });
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await jpeg.arrayBuffer())], [255, 216, 255, 217]);
  for (const photo of [unshared, other])
    assert.equal((await call(previewOf(photo.id), null, 'GET', undefined, headers)).status, 404);
  assert.equal(
    (await call(`${root}/assets/${first.id}/download`, null, 'GET', undefined, headers)).status,
    401,
  );
  assert.equal(
    (
      await call(`${shares}/${link.id}`, owner, 'DELETE', undefined, {
        Origin: 'https://foreign.invalid',
      })
    ).status,
    403,
  );
  assert.equal((await call(`${shares}/${link.id}`, owner, 'DELETE')).status, 204);
  assert.equal((await call(shared, null, 'GET', undefined, headers)).status, 404);
  assert.equal((await call(previewOf(first.id), null, 'GET', undefined, headers)).status, 404);
});

test('分享访问密码限制尝试，解锁只授权当前链接，更换密码后已有授权失效', async () => {
  const owner = await user(),
    other = await user(true);
  const photo = await seed(owner);
  const password = '分享测试-2026';
  const create = async (config) =>
    call(shares, owner, 'POST', { ids: [photo.id], days: 7, ...config });
  for (const [config, field] of [
    [{ password: 'short' }, 'password'],
    [{ password: '密'.repeat(25) }, 'password'],
    [{ allowDownload: 'true' }, 'allowDownload'],
  ]) {
    const result = await create(config);
    assert.equal(result.status, 400);
    const error = await result.json();
    assert.deepEqual(error.errors[0].path, [field]);
    assert.ok(!JSON.stringify(error).includes(String(config.password)));
  }
  const result = await create({ password, allowDownload: true });
  assert.equal(result.status, 201);
  const link = await result.json();
  assert.equal(link.passwordRequired, true);
  assert.equal(link.allowDownload, true);
  assert.ok(!JSON.stringify(link).includes(password));
  const stored = await db
    .prepare('SELECT password_hash FROM web_shares WHERE id=?')
    .bind(link.id)
    .first();
  assert.ok(await bcrypt.compare(password, stored.password_hash));
  const header = shareAuth(link);
  const path = shares + '/' + link.id;
  const update = (options, actor = owner, extra) => call(path, actor, 'PATCH', options, extra);
  const unlock = (value, extra) =>
    call(shared + '/unlock', null, 'POST', { password: value }, { ...header, ...extra });
  const view = (route, headers = header) => call(route, null, 'GET', undefined, headers);
  for (const route of [shared, previewOf(photo.id), originalOf(photo.id)]) {
    const response = await view(route);
    assert.equal(response.status, 401);
    assert.deepEqual((await response.json()).errors[0].path, ['password']);
  }
  assert.equal((await unlock(password, { Origin: 'https://foreign.invalid' })).status, 403);
  const wrong = await unlock('wrong-password');
  assert.equal(wrong.status, 403);
  assert.doesNotMatch(await wrong.text(), /wrong-password/);
  const unlocked = await unlock(password);
  assert.equal(unlocked.status, 200);
  const { accessToken } = await unlocked.json();
  assert.match(accessToken, /^[a-f0-9]{64}$/);
  const guest = { Authorization: header.Authorization + '.' + accessToken };
  const saved = await view(originalOf(photo.id), guest);
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), Buffer.from(photo.content));
  const another = await (await create({ password })).json();
  assert.equal(
    (await view(shared, { Authorization: shareAuth(another).Authorization + '.' + accessToken }))
      .status,
    401,
  );

  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal((await unlock('wrong-password')).status, 403);
  assert.equal((await unlock(password)).status, 429);
  assert.equal((await update({ allowDownload: false }, other)).status, 404);
  assert.equal(
    (await update({ allowDownload: false }, owner, { Origin: 'https://foreign.invalid' })).status,
    403,
  );
  assert.equal((await update({ allowDownload: false })).status, 200);
  assert.equal((await view(shared, guest)).status, 200);
  assert.equal((await view(originalOf(photo.id), guest)).status, 403);
  const nextPassword = 'another-passphrase';
  const replaced = await update({ password: nextPassword });
  assert.equal(replaced.status, 200);
  assert.doesNotMatch(await replaced.text(), /another-passphrase|password_hash/);
  assert.equal((await view(shared, guest)).status, 401);
  assert.equal((await unlock(password)).status, 403);
  assert.equal((await unlock(nextPassword)).status, 200);
  assert.equal((await update({ password: null })).status, 200);
  assert.equal((await view(shared)).status, 200);
  assert.equal((await view(originalOf(photo.id))).status, 403);
});

test('允许下载时相册访客可保存照片和配套 MOV，移出相册或撤销会阻断下载', async () => {
  const owner = await user(),
    foreign = await user();
  const pair = pairId();
  const motion = await seed(owner, liveMov(pair), 'video/quicktime', {
    pair,
    type: 'VIDEO',
    visibility: 'hidden',
    filename: '动态原件.MOV',
  });
  const photo = await seed(owner, liveJpeg(pair), 'image/jpeg', { pair, video: motion.id });
  const outside = await seed(foreign);
  const album = await (
    await call('/api/albums', owner, 'POST', {
      albumName: '下载验收',
      assetIds: [photo.id],
    })
  ).json();
  const response = await call(shares, owner, 'POST', {
    albumId: album.id,
    days: 1,
    allowDownload: true,
  });
  assert.equal(response.status, 201);
  const link = await response.json();
  const header = shareAuth(link);
  const page = await (await call(shared, null, 'GET', undefined, header)).json();
  assert.equal(page.allowDownload, true);
  assert.deepEqual(page.items, [{ id: photo.id, hasMotion: true }]);
  const original = (id, component) =>
    call(originalOf(id, component), null, 'GET', undefined, header);
  const file = await original(photo.id, 'motion');
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'video/quicktime');
  assert.match(file.headers.get('content-disposition'), /filename="photo.mov"/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(motion.content));
  assert.equal((await original(motion.id)).status, 404);
  assert.equal((await original(outside.id)).status, 404);
  await call(`/api/albums/${album.id}/assets`, owner, 'DELETE', { ids: [photo.id] });
  assert.equal((await original(photo.id, 'motion')).status, 404);
  await call(`/api/albums/${album.id}/assets`, owner, 'PUT', { ids: [photo.id] });
  assert.equal((await call(shares + '/' + link.id, owner, 'DELETE')).status, 204);
  assert.equal((await original(photo.id)).status, 404);
});

test('整本相册分享按完整相册分页，实时应用成员和回收变化，过期、删除与停用撤销访问', async () => {
  const owner = await user(),
    other = await user(true);
  const first = await seed(owner),
    second = await seed(owner),
    added = await seed(owner);
  const album = await (
    await call('/api/albums', owner, 'POST', {
      albumName: '分享相册',
      assetIds: [first.id, second.id],
    })
  ).json();
  const scope = { albumId: album.id, days: 1 };
  assert.equal((await call(shares, other, 'POST', scope)).status, 404);
  const create = async () => {
    const r = await call(shares, owner, 'POST', scope);
    assert.equal(r.status, 201);
    return r.json();
  };
  const link = await create(),
    headers = shareAuth(link);
  const get = async (suffix = '') => {
    const r = await call(shared + suffix, null, 'GET', undefined, headers);
    assert.equal(r.status, 200);
    return r.json();
  };
  const p = await get('?limit=1');
  assert.equal(p.title, '分享相册');
  assert.equal(p.items.length, 1);
  const next = await get('?limit=1&cursor=' + p.nextCursor);
  assert.deepEqual(
    [...p.items, ...next.items].map((item) => item.id).sort(),
    [first.id, second.id].sort(),
  );
  assert.equal(next.nextCursor, null);

  await call(`/api/albums/${album.id}/assets`, owner, 'DELETE', { ids: [first.id] });
  await call(`/api/albums/${album.id}/assets`, owner, 'PUT', { ids: [added.id] });
  await call('/api/assets', owner, 'DELETE', { ids: [second.id], force: false });
  assert.deepEqual((await get()).items, [{ id: added.id }]);
  for (const photo of [first, second])
    assert.equal((await call(previewOf(photo.id), null, 'GET', undefined, headers)).status, 404);

  await db.prepare('UPDATE web_shares SET expires_ms=0 WHERE id=?').bind(link.id).run();
  assert.equal((await call(shared, null, 'GET', undefined, headers)).status, 404);
  const deletedAlbum = await create();
  const selected = await (await call(shares, owner, 'POST', { ids: [added.id], days: 7 })).json();
  assert.equal((await call(`/api/albums/${album.id}`, owner, 'DELETE')).status, 204);
  assert.equal((await call(shared, null, 'GET', undefined, shareAuth(deletedAlbum))).status, 404);
  assert.equal(
    (await call(`${adminRoot}/${owner.id}`, other, 'PATCH', { disabled: true })).status,
    204,
  );
  assert.equal(
    (await call(`${adminRoot}/${owner.id}`, other, 'PATCH', { disabled: false })).status,
    204,
  );
  assert.equal((await call(shared, null, 'GET', undefined, shareAuth(selected))).status, 404);
});

const prepareZip = (u, input) => call(root + '/downloads', u, 'POST', input);
function inspectZip(bytes) {
  return JSON.parse(
    execFileSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [
        '-X',
        'utf8',
        '-c',
        'import sys,io,zipfile,json,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps([{ "name":i.filename,"bytes":i.file_size,"sha1":hashlib.sha1(z.read(i)).hexdigest()} for i in z.infolist()]))',
      ],
      { input: Buffer.from(bytes), maxBuffer: 2 * 1024 ** 2, encoding: 'utf8' },
    ),
  );
}
test('所选照片 ZIP 包含原件及 Live Photo MOV，中文重名不覆盖且独立解压/CRC/SHA-1 验证通过', async () => {
  const u = await user(),
    pair = pairId(),
    motion = await seed(u, liveMov(pair), 'video/quicktime', {
      pair,
      type: 'VIDEO',
      visibility: 'hidden',
    }),
    live = await seed(u, liveHeic(pair), 'image/heic', {
      pair,
      video: motion.id,
      filename: '旅行.heic',
    }),
    one = await seed(u, undefined, undefined, { filename: '同名.jpg' }),
    two = await seed(u, undefined, undefined, { filename: '同名.jpg' });
  const prepared = await prepareZip(u, { ids: [one.id, two.id, live.id] });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const plan = await prepared.json();
  assert.equal(plan.photos, 3);
  assert.equal(plan.files, 4);
  assert.equal(plan.parts.length, 1);
  assert.doesNotMatch(JSON.stringify(plan), /object_key|checksum|session_id|entries/);
  const part = plan.parts[0],
    attempt = randomUUID(),
    response = await call(part.downloadPath + '?attempt=' + attempt, u);
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type'), /application\/zip/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const bytes = await response.arrayBuffer();
  assert.equal(bytes.byteLength, Number(response.headers.get('content-length')));
  const files = inspectZip(bytes);
  assert.equal(files.length, 4);
  assert.equal(new Set(files.map((x) => x.name.toLowerCase())).size, 4);
  assert.ok(files.some((x) => x.name === '旅行.heic'));
  assert.ok(files.some((x) => x.name === '旅行.mov'));
  assert.ok(files.some((x) => x.name === '同名.jpg'));
  assert.ok(files.some((x) => x.name === '同名 (2).jpg'));
  assert.deepEqual(
    files.map((x) => x.sha1).sort(),
    [one, two, live, motion].map((x) => createHash('sha1').update(x.content).digest('hex')).sort(),
  );
  const status = await (await call(`${root}/downloads/${part.id}`, u)).json();
  assert.equal(status.state, 'complete');
  assert.equal(status.completedFiles, 4);
  assert.equal(status.runId, attempt);
});
test('整本相册下载覆盖未加载照片，1001 项自动分包，权限/范围/会话与过期错误可定位', async () => {
  const u = await user(),
    other = await user(),
    ids = [];
  for (let at = 0; at < 1001; at += 50)
    await db.batch(
      Array.from({ length: Math.min(50, 1001 - at) }, (_, n) => {
        const id = randomUUID();
        ids.push(id);
        const date = '2026-11-11T00:00:00.000Z';
        return db
          .prepare(
            "INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES(?,?,?,?,?,'image/jpeg',4,1,1,?,?,?,0)",
          )
          .bind(id, u.id, id, id, `未加载-${at + n}.jpg`, date, date, date);
      }),
    );
  const album = await (
    await call('/api/albums', u, 'POST', { albumName: '整本相册', assetIds: ids.slice(0, 1000) })
  ).json();
  await call(`/api/albums/${album.id}/assets`, u, 'PUT', { ids: ids.slice(1000) });
  const plan = await (await prepareZip(u, { albumId: album.id })).json();
  assert.equal(plan.photos, 1001);
  assert.equal(plan.files, 1001);
  assert.equal(plan.parts.length, 2);
  const snapshots = await db
    .prepare('SELECT entries FROM web_download_jobs WHERE owner_id=?')
    .bind(u.id)
    .all();
  assert.equal(
    new Set(snapshots.results.flatMap((row) => JSON.parse(row.entries).map((x) => x.id))).size,
    1001,
  );
  const part = plan.parts[0];
  assert.equal((await call(part.downloadPath + '?attempt=' + randomUUID(), other)).status, 404);
  assert.equal((await call(`${root}/downloads/${part.id}`, other)).status, 404);
  assert.equal((await prepareZip(other, { albumId: album.id })).status, 404);
  for (const input of [
    { ids: [] },
    { ids: [ids[0]], albumId: album.id },
    { ids: [ids[0], ids[0]] },
    { ids: [randomUUID()] },
  ]) {
    const r = await prepareZip(u, input);
    assert.ok([400, 404].includes(r.status));
    assert.ok((await r.json()).errors[0].path.length);
  }
  assert.equal((await prepareZip(null, { ids: [ids[0]] })).status, 401);
  assert.equal(
    (
      await call(
        root + '/downloads',
        u,
        'POST',
        { ids: [ids[0]] },
        { Origin: 'https://other.invalid' },
      )
    ).status,
    403,
  );
  const replacement = await user();
  await db.prepare('UPDATE web_download_jobs SET expires_ms=0 WHERE id=?').bind(part.id).run();
  assert.equal((await call(`${root}/downloads/${part.id}`, u)).status, 410);
  assert.equal((await call(`${root}/downloads/${part.id}`, replacement)).status, 404);
});
test('ZIP 原件缺失/等长损坏明确失败，图库变化拒绝旧快照，回收站所选仍可下载', async () => {
  const u = await user(),
    a = await seed(u),
    b = await seed(u);
  const plan = await (await prepareZip(u, { ids: [a.id] })).json(),
    part = plan.parts[0];
  await bucket.delete(a.key);
  const missing = await call(part.downloadPath + '?attempt=' + randomUUID(), u);
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).message, /原件暂不可读取/);
  assert.equal((await (await call(`${root}/downloads/${part.id}`, u)).json()).state, 'failed');
  await bucket.put(a.key, Buffer.alloc(a.content.length, 1), {
    sha1: createHash('sha1').update(Buffer.alloc(a.content.length, 1)).digest(),
  });
  const corrupt = await call(part.downloadPath + '?attempt=' + randomUUID(), u);
  assert.equal(corrupt.status, 503);
  assert.match((await corrupt.json()).message, /校验不符/);
  const fresh = await (await prepareZip(u, { ids: [b.id] })).json();
  await call('/api/assets', u, 'PUT', { ids: [b.id], isFavorite: true });
  assert.equal(
    (await call(fresh.parts[0].downloadPath + '?attempt=' + randomUUID(), u)).status,
    409,
  );
  await call('/api/assets', u, 'DELETE', { ids: [b.id] });
  const trashed = await (await prepareZip(u, { ids: [b.id] })).json();
  assert.equal(
    inspectZip(
      await (
        await call(trashed.parts[0].downloadPath + '?attempt=' + randomUUID(), u)
      ).arrayBuffer(),
    ).length,
    1,
  );
});

test('ZIP 逐块校验识别无原生 SHA-1 的等长损坏，传输中取消不会留下成功任务', async () => {
  const u = await user(),
    file = await seed(u);
  await db.prepare('UPDATE assets SET r2_sha1_verified=0 WHERE id=?').bind(file.id).run();
  await bucket.put(file.key, Buffer.alloc(file.content.length, 7));
  const part = (await (await prepareZip(u, { ids: [file.id] })).json()).parts[0];
  const response = await call(part.downloadPath + '?attempt=' + randomUUID(), u, 'GET', undefined, {
    Connection: 'close',
  });
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer());
  const status = await (await call(`${root}/downloads/${part.id}`, u)).json();
  assert.equal(status.state, 'failed');
  assert.match(status.error, /校验不符/);
  assert.equal(status.completedFiles, 0);
  const large = await seed(u, Buffer.alloc(19_000_000, 5));
  const task = (await (await prepareZip(u, { ids: [large.id] })).json()).parts[0];
  const streamed = await call(task.downloadPath + '?attempt=' + randomUUID(), u, 'GET', undefined, {
    Connection: 'close',
  });
  const reader = streamed.body.getReader();
  await reader.read();
  assert.equal((await call(`${root}/downloads/${task.id}`, u, 'DELETE')).status, 204);
  await reader.cancel().catch(() => undefined);
  const cancelled = await (await call(`${root}/downloads/${task.id}`, u)).json();
  assert.equal(cancelled.state, 'cancelled');
});

async function browserUpload(u, bytes, name, fields = {}, headers = {}) {
  const form = new FormData();
  form.append('assetData', new File([bytes], name));
  form.append('fileCreatedAt', '2026-11-11T00:00:00.000Z');
  form.append('fileModifiedAt', '2026-11-11T00:00:00.000Z');
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const request = new Request('http://localhost', { method: 'POST', body: form });
  return worker.fetch(root + '/upload', {
    method: 'POST',
    headers: {
      Origin: origin,
      ...(u ? { Cookie: `immich_access_token=${u.token}` } : {}),
      'Content-Type': request.headers.get('Content-Type'),
      'x-immich-checksum': createHash('sha1').update(bytes).digest('hex'),
      ...headers,
    },
    body: await request.arrayBuffer(),
  });
}

test('浏览器 Cookie 同源上传 JPEG/PNG、内容去重、私有读取和相册添加，错误校验和不写资产', async () => {
  const u = await user(),
    foreign = await user(),
    jpeg = await readFile('tests/fixtures/small.jpg'),
    png = await readFile('tests/fixtures/small.png');
  const r = await browserUpload(u, jpeg, '浏览器原件.jpg');
  assert.equal(r.status, 201, await r.clone().text());
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const photo = await r.json();
  assert.equal(photo.status, 'created');
  const again = await browserUpload(u, jpeg, '改名后的同一原件.jpg');
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { id: photo.id, status: 'duplicate' });
  const p = await browserUpload(u, png, '浏览器原件.png');
  assert.equal(p.status, 201);
  const page = await (await call(root + '/assets', u)).json();
  assert.equal(page.items.length, 2);
  assert.equal(
    page.items.find((item) => item.id === photo.id).fileCreatedAt,
    '2026-11-11T00:00:00.000Z',
  );
  assert.deepEqual(
    Buffer.from(await (await call(`${root}/assets/${photo.id}/download`, u)).arrayBuffer()),
    jpeg,
  );
  assert.equal((await call(`${root}/assets/${photo.id}/download`, foreign)).status, 404);
  const album = await (
    await call('/api/albums', u, 'POST', { albumName: '浏览器上传相册' })
  ).json();
  assert.equal(
    (await call(`/api/albums/${album.id}/assets`, u, 'PUT', { ids: [photo.id] })).status,
    200,
  );
  assert.equal(
    (await (await call(`${root}/assets?view=album&albumId=${album.id}`, u)).json()).items.length,
    1,
  );
  const bad = await browserUpload(
    u,
    jpeg,
    'checksum.jpg',
    {},
    { 'x-immich-checksum': '0'.repeat(40) },
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).errors[0].path[0], 'x-immich-checksum');
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=?').bind(u.id).first()).n,
    2,
  );
});

test('浏览器上传拒绝跨站/无来源/未登录；校验错误定位文件和时间，重复原件不消耗额外名额', async () => {
  const u = await user(),
    jpeg = await readFile('tests/fixtures/small.jpg'),
    png = await readFile('tests/fixtures/small.png');
  assert.equal((await browserUpload(null, jpeg, 'anonymous.jpg')).status, 401);
  assert.equal(
    (await browserUpload(u, jpeg, 'cross-site.jpg', {}, { Origin: 'https://other.invalid' }))
      .status,
    403,
  );
  assert.equal((await browserUpload(u, jpeg, 'no-origin.jpg', {}, { Origin: '' })).status, 403);
  assert.equal((await call(root + '/upload', u)).status, 405);
  const badDate = await browserUpload(u, jpeg, 'invalid-date.jpg', { fileCreatedAt: 'not-a-date' });
  assert.equal(badDate.status, 400);
  assert.equal((await badDate.json()).errors[0].path[0], 'fileCreatedAt');
  const badFile = await browserUpload(u, Buffer.from('invalid-image'), 'invalid.jpg');
  assert.equal(badFile.status, 400);
  assert.equal((await badFile.json()).errors[0].path[0], 'assetData');
  assert.equal((await browserUpload(u, jpeg, 'valid.jpg')).status, 201);
  try {
    await db.prepare('UPDATE asset_quota_config SET logical_limit=1 WHERE id=1').run();
    assert.equal((await browserUpload(u, jpeg, 'duplicate.jpg')).status, 200);
    const over = await browserUpload(u, png, 'new.png');
    assert.equal(over.status, 409);
    assert.match((await over.json()).message, /名额|上限/);
  } finally {
    await db.prepare('UPDATE asset_quota_config SET logical_limit=10000 WHERE id=1').run();
  }
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=?').bind(u.id).first()).n,
    1,
  );
});

test('浏览器先上传 MOV 再配对 HEIC，同组重试仅一逻辑资产，孤立视频和错误配对明确拒绝', async () => {
  const u = await user(),
    pair = pairId(),
    motion = liveMov(pair),
    still = liveHeic(pair);
  const isolated = await browserUpload(u, motion, 'pair.mov');
  assert.equal(isolated.status, 400);
  assert.equal((await isolated.json()).errors[0].path[0], 'visibility');
  const missing = await browserUpload(u, still, 'pair.heic');
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).errors[0].path[0], 'livePhotoVideoId');
  const m = await browserUpload(u, motion, 'pair.mov', { visibility: 'hidden' });
  assert.equal(m.status, 201);
  const video = await m.json();
  const wrong = await browserUpload(u, liveHeic(pairId()), 'pair.heic', {
    livePhotoVideoId: video.id,
  });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).errors[0].path[0], 'livePhotoVideoId');
  const p = await browserUpload(u, still, 'pair.heic', { livePhotoVideoId: video.id });
  assert.equal(p.status, 201);
  const photo = await p.json();
  const repeat = await browserUpload(u, still, 'pair.heic', { livePhotoVideoId: video.id });
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).id, photo.id);
  const bootstrap = await (await call(root + '/bootstrap', u)).json();
  assert.equal(bootstrap.usage.logicalAssets, 1);
  const page = await (await call(root + '/assets', u)).json();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].livePhotoVideoId, video.id);
  assert.deepEqual(
    Buffer.from(await (await call(`${root}/assets/${photo.id}/download`, u)).arrayBuffer()),
    still,
  );
  assert.deepEqual(
    Buffer.from(
      await (await call(`${root}/assets/${photo.id}/download?component=motion`, u)).arrayBuffer(),
    ),
    motion,
  );
});
test('年月概览和定位覆盖 1001 张照片，双向分页无遗漏并绑定账号、筛选和版本', async () => {
  const owner = await user(),
    foreign = await user();
  const ids = [];
  for (let at = 0; at < 1001; at += 50)
    await db.batch(
      Array.from({ length: Math.min(50, 1001 - at) }, (_, index) => {
        const i = at + index,
          id = randomUUID();
        ids.push(id);
        const date = new Date(
          Date.UTC(
            2020 + Math.floor(i / 360),
            Math.floor(i / 30) % 12,
            Math.floor((i % 30) / 3) + 1,
            10,
          ),
        ).toISOString();
        return db
          .prepare(
            `INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite)
        VALUES(?,?,?,?,?,?,4,1,1,?,?,?,?)`,
          )
          .bind(
            id,
            owner.id,
            id,
            owner.id + '/' + id,
            'timeline-' + i + '.jpg',
            i % 3 ? 'image/jpeg' : 'image/png',
            date,
            date,
            date,
            i % 2,
          );
      }),
    );
  const overview = async (suffix = '', actor = owner) => {
    const result = await call(root + '/timeline?timeZone=Asia%2FShanghai' + suffix, actor);
    assert.equal(result.status, 200);
    return result.json();
  };
  const months = await overview();
  assert.equal(
    months.months.reduce((n, month) => n + month.count, 0),
    1001,
  );
  assert.equal(months.months.length, 34);
  assert.doesNotMatch(JSON.stringify(months), /object_key|checksum|filename/);
  const middle = months.months[12];
  const position =
    '&anchorTime=' + encodeURIComponent(middle.anchorTime) + '&anchorId=' + middle.anchorId;
  const page = await (await call(root + '/assets?limit=17' + position, owner)).json();
  assert.equal(page.items[0].id, middle.anchorId);
  assert.ok(page.previousCursor && page.nextCursor);
  const all = [...page.items];
  let previous = page.previousCursor;
  while (previous) {
    const r = await call(root + '/assets?limit=100&cursor=' + encodeURIComponent(previous), owner);
    assert.equal(r.status, 200);
    const data = await r.json();
    all.unshift(...data.items);
    previous = data.previousCursor;
  }
  let next = page.nextCursor;
  while (next) {
    const r = await call(root + '/assets?limit=100&cursor=' + encodeURIComponent(next), owner);
    assert.equal(r.status, 200);
    const data = await r.json();
    all.push(...data.items);
    next = data.nextCursor;
  }
  assert.equal(all.length, 1001);
  assert.equal(new Set(all.map(({ id }) => id)).size, 1001);
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1],
      b = all[i];
    assert.ok(
      Date.parse(a.fileCreatedAt) > Date.parse(b.fileCreatedAt) ||
        (a.fileCreatedAt === b.fileCreatedAt && a.id > b.id),
    );
  }
  const oldest = await overview('&order=oldest');
  assert.deepEqual(
    oldest.months.map((m) => m.key),
    months.months.map((m) => m.key).reverse(),
  );
  const ascending = await (
    await call(
      root +
        '/assets?order=oldest&limit=4&anchorTime=' +
        encodeURIComponent(oldest.months[12].anchorTime) +
        '&anchorId=' +
        oldest.months[12].anchorId,
      owner,
    )
  ).json();
  assert.equal(ascending.items[0].id, oldest.months[12].anchorId);
  const before = await (
    await call(
      root + '/assets?order=oldest&limit=4&cursor=' + encodeURIComponent(ascending.previousCursor),
      owner,
    )
  ).json();
  assert.ok(
    Date.parse(before.items.at(-1).fileCreatedAt) <= Date.parse(ascending.items[0].fileCreatedAt),
  );
  assert.equal((await call(root + '/assets?cursor=' + page.nextCursor, foreign)).status, 400);
  assert.equal(
    (await call(root + '/assets?view=favorites&cursor=' + page.nextCursor, owner)).status,
    400,
  );
  const favorites = await overview('&view=favorites&type=png&q=timeline-');
  assert.equal(
    favorites.months.reduce((n, m) => n + m.count, 0),
    ids.filter((_, i) => i % 2 && i % 3 === 0).length,
  );
  const album = await (
    await call('/api/albums', owner, 'POST', {
      albumName: '日期定位',
      assetIds: ids.slice(0, 120),
    })
  ).json();
  assert.equal(
    (await overview('&view=album&albumId=' + album.id)).months.reduce((n, m) => n + m.count, 0),
    120,
  );
  assert.equal(
    (await call(root + '/timeline?view=album&albumId=' + album.id, foreign)).status,
    404,
  );
  assert.equal((await call(root + '/assets?cursor=' + page.nextCursor, owner)).status, 409);
});

test('年月概览遵循 IANA 时区、夏令时和筛选，失效定位选择最近照片，参数错误定位字段', async () => {
  const owner = await user();
  const dates = [
    '2025-12-31T16:00:00.000Z',
    '2026-03-01T07:30:00.000Z',
    '2026-03-01T08:30:00.000Z',
    '2026-03-08T09:59:00.000Z',
    '2026-03-08T10:00:00.000Z',
    '2026-11-01T08:30:00.000Z',
    '2026-11-01T09:30:00.000Z',
  ];
  const photos = [];
  for (const date of dates)
    photos.push(await seed(owner, liveJpeg(pairId()), 'image/jpeg', { date }));
  const get = async (zone, extra = '') => {
    const r = await call(root + '/timeline?timeZone=' + encodeURIComponent(zone) + extra, owner);
    assert.equal(r.status, 200);
    return r.json();
  };
  const shanghai = await get('Asia/Shanghai');
  const la = await get('America/Los_Angeles');
  assert.deepEqual(
    shanghai.months.map(({ key, count }) => [key, count]),
    [
      ['2026-11', 2],
      ['2026-03', 4],
      ['2026-01', 1],
    ],
  );
  assert.deepEqual(
    la.months.map(({ key, count }) => [key, count]),
    [
      ['2026-11', 2],
      ['2026-03', 3],
      ['2026-02', 1],
      ['2025-12', 1],
    ],
  );
  assert.equal((await get('Asia/Shanghai', '&version=' + shanghai.version)).unchanged, true);
  assert.equal((await call(root + '/timeline', null)).status, 401);
  for (const [route, field] of [
    ['/timeline?timeZone=not-a-zone', 'timeZone'],
    ['/timeline?view=trash', 'view'],
    ['/assets?anchorId=' + photos[0].id, 'anchorTime'],
    ['/assets?anchorTime=bad', 'anchorTime'],
    ['/assets?limit=1&limit=2', 'limit'],
  ]) {
    const r = await call(root + route, owner);
    assert.equal(r.status, 400);
    assert.deepEqual((await r.json()).errors[0].path, [field]);
  }
  await call('/api/assets', owner, 'DELETE', { ids: [photos[1].id] });
  const near = await (
    await call(
      root + '/assets?anchorTime=' + encodeURIComponent(dates[1]) + '&anchorId=' + photos[1].id,
      owner,
    )
  ).json();
  assert.equal(near.items[0].id, photos[2].id);
  const refreshed = await get('Asia/Shanghai', '&version=' + shanghai.version);
  assert.ok(!refreshed.unchanged);
  assert.equal(
    refreshed.months.reduce((n, m) => n + m.count, 0),
    6,
  );
  const r = await call(
    root + '/assets?cursor=' + near.previousCursor + '&anchorTime=' + encodeURIComponent(dates[0]),
    owner,
  );
  assert.equal(r.status, 400);
  assert.deepEqual((await r.json()).errors[0].path, ['cursor/anchorTime']);
});

test('1001 张跨日期照片稳定分页、收藏/回收站/相册筛选、游标隔离与变化冲突', async () => {
  const u = await user(),
    foreign = await user();
  for (let at = 0; at < 1001; at += 50) {
    const statements = [];
    for (let i = at; i < Math.min(at + 50, 1001); i++) {
      const id = randomUUID(),
        d = new Date(Date.UTC(2026, 9, 1) + Math.floor(i / 13) * 3600000).toISOString();
      statements.push(
        db
          .prepare(
            "INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES(?,?,?,?,?,'image/jpeg',4,1,1,?,?,?,?)",
          )
          .bind(
            id,
            u.id,
            'sum-' + id,
            u.id + '/' + id,
            'synthetic-' + i + '.jpg',
            d,
            d,
            d,
            i % 3 === 0 ? 1 : 0,
          ),
      );
    }
    await db.batch(statements);
  }
  let cursor = null,
    seen = [],
    firstCursor;
  do {
    const r = await call(root + '/assets?limit=100' + (cursor ? '&cursor=' + cursor : ''), u);
    assert.equal(r.status, 200, await r.clone().text());
    const page = await r.json();
    assert.ok(page.items.length <= 100);
    seen.push(...page.items);
    cursor = page.nextCursor;
    firstCursor ||= cursor;
  } while (cursor);
  assert.equal(seen.length, 1001);
  assert.equal(new Set(seen.map((x) => x.id)).size, 1001);
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1],
      b = seen[i];
    assert.ok(
      Date.parse(a.fileCreatedAt) > Date.parse(b.fileCreatedAt) ||
        (a.fileCreatedAt === b.fileCreatedAt && a.id > b.id),
    );
  }
  assert.doesNotMatch(JSON.stringify(seen), /object_key|integrity_source/);
  assert.equal((await call(root + '/assets?limit=101', u)).status, 400);
  for (const value of ['null', 'false', '0', '""'])
    assert.equal(
      (await call(root + '/assets?cursor=' + Buffer.from(value).toString('base64url'), u)).status,
      400,
    );
  assert.equal((await call(root + '/assets?cursor=' + firstCursor, foreign)).status, 400);
  assert.equal((await call(root + '/assets?view=favorites&cursor=' + firstCursor, u)).status, 400);
  const favorite = await (await call(root + '/assets?view=favorites', u)).json();
  assert.ok(favorite.items.every((p) => p.isFavorite));
  let r = await call('/api/albums', u, 'POST', { albumName: '网页相册', assetIds: [seen[0].id] });
  assert.equal(r.status, 201);
  const album = await r.json();
  const page = await (await call(root + '/assets?view=album&albumId=' + album.id, u)).json();
  assert.equal(page.items.length, 1);
  assert.equal((await call(root + '/assets?view=album&albumId=' + album.id, foreign)).status, 404);
  assert.equal((await call(root + '/assets?cursor=' + firstCursor, u)).status, 409);
  assert.equal((await call('/api/assets', u, 'DELETE', { ids: [seen[0].id] })).status, 204);
  const trash = await (await call(root + '/assets?view=trash', u)).json();
  assert.equal(trash.items.length, 1);
  assert.equal(trash.items[0].id, seen[0].id);
  assert.equal(
    (await call('/api/trash/restore/assets', u, 'POST', { ids: [seen[0].id] })).status,
    200,
  );
});
test('照片按文件名全文库查询、字面通配符、拍摄日期和类型组合筛选，四种视图保持隔离', async () => {
  const u = await user(),
    foreign = await user(),
    pair = pairId();
  const motion = await seed(u, liveMov(pair), 'video/quicktime', {
    type: 'VIDEO',
    visibility: 'hidden',
    pair,
  });
  const live = await seed(u, undefined, undefined, {
    filename: '旅行 Live.JPG',
    date: '2026-11-01T16:00:00.000Z',
    video: motion.id,
    pair,
  });
  const png = await seed(u, undefined, 'image/png', {
    filename: '旅行 100%_\\日落.png',
    date: '2026-11-02T15:59:59.999Z',
  });
  const outside = await seed(u, undefined, undefined, {
    filename: '旅行 100abxx日落.jpg',
    date: '2026-11-02T16:00:00.000Z',
  });
  const heic = await seed(u, undefined, 'image/heic', {
    filename: '旅行.heic',
    date: '2026-11-01T15:59:59.999Z',
  });
  await seed(foreign, undefined, 'image/png', { filename: '旅行 100%_\\日落.png' });
  const search = async (params) => {
    const r = await call(root + '/assets?' + new URLSearchParams(params), u);
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()).items;
  };
  assert.deepEqual(
    (await search({ q: '100%_\\' })).map((p) => p.id),
    [png.id],
  );
  assert.deepEqual(await search({ q: "' OR 1=1 --" }), []);
  assert.deepEqual(
    (await search({ q: '  live  ', type: 'live' })).map((p) => p.id),
    [live.id],
  );
  assert.deepEqual(
    (await search({ type: 'heic' })).map((p) => p.id),
    [heic.id],
  );
  assert.equal((await search({ type: 'static' })).length, 3);
  const range = { q: '旅行', from: '2026-11-01T16:00:00.000Z', to: '2026-11-02T16:00:00.000Z' };
  assert.deepEqual(
    (await search(range)).map((p) => p.id),
    [png.id, live.id],
  );
  assert.deepEqual(
    (await search({ ...range, type: 'png' })).map((p) => p.id),
    [png.id],
  );
  await call('/api/assets', u, 'PUT', { ids: [live.id], isFavorite: true });
  assert.deepEqual(
    (await search({ ...range, view: 'favorites' })).map((p) => p.id),
    [live.id],
  );
  const album = await (
    await call('/api/albums', u, 'POST', { albumName: '筛选相册', assetIds: [png.id, outside.id] })
  ).json();
  assert.deepEqual(
    (await search({ ...range, view: 'album', albumId: album.id })).map((p) => p.id),
    [png.id],
  );
  await call('/api/assets', u, 'DELETE', { ids: [png.id] });
  assert.deepEqual(
    (await search({ ...range, type: 'png', view: 'trash' })).map((p) => p.id),
    [png.id],
  );
  assert.deepEqual(await search({ ...range, type: 'png' }), []);
});

test('搜索超过首屏的照片，升降序跨页无遗漏且游标绑定所有筛选与账号', async () => {
  const u = await user(),
    foreign = await user(),
    date = '2026-11-02T00:00:00.000Z';
  for (let start = 0; start < 125; start += 50) {
    await db.batch(
      Array.from({ length: Math.min(50, 125 - start) }, (_, offset) => {
        const id = randomUUID(),
          i = start + offset;
        return db
          .prepare(
            "INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES(?,?,?,?,?,'image/jpeg',4,1,1,?,?,?,0)",
          )
          .bind(id, u.id, id, id, `batch-${i}.jpg`, date, date, date);
      }),
    );
  }
  for (const order of ['newest', 'oldest']) {
    const seen = [];
    let cursor;
    do {
      const r = await call(
        root +
          '/assets?' +
          new URLSearchParams({ q: 'batch-', order, limit: '7', ...(cursor ? { cursor } : {}) }),
        u,
      );
      assert.equal(r.status, 200, await r.clone().text());
      const page = await r.json();
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
      if (seen.length === 7) {
        for (const change of [
          { q: 'batch-1' },
          { order: order === 'newest' ? 'oldest' : 'newest' },
          { type: 'jpeg' },
          { from: date },
          { to: '2027-01-01T00:00:00.000Z' },
        ]) {
          const mismatch = await call(
            root + '/assets?' + new URLSearchParams({ q: 'batch-', order, cursor, ...change }),
            u,
          );
          assert.equal(mismatch.status, 400);
          assert.equal((await mismatch.json()).errors[0].path[0], 'cursor');
        }
        assert.equal(
          (
            await call(
              root + '/assets?' + new URLSearchParams({ q: 'batch-', order, cursor }),
              foreign,
            )
          ).status,
          400,
        );
      }
    } while (cursor);
    assert.equal(seen.length, 125);
    assert.equal(new Set(seen).size, 125);
    const sorted = [...seen].sort();
    assert.deepEqual(seen, order === 'newest' ? sorted.reverse() : sorted);
    const last = (
      await (await call(root + '/assets?' + new URLSearchParams({ order, limit: '100' }), u)).json()
    ).nextCursor;
    const tail = (
      await (await call(root + '/assets?' + new URLSearchParams({ order, cursor: last }), u)).json()
    ).items.at(-1);
    const match = await (
      await call(root + '/assets?' + new URLSearchParams({ q: tail.originalFileName }), u)
    ).json();
    assert.deepEqual(
      match.items.map((p) => p.id),
      [tail.id],
    );
  }
});

test('筛选错误定位具体字段、说明修正要求且不回显提交值', async () => {
  const u = await user();
  for (const [params, field, message] of [
    [{ q: 'sensitive-'.repeat(12) }, 'q', /文件名.*100.*缩短/],
    [{ from: '2026-02-30T00:00:00.000Z' }, 'from', /拍摄开始时间.*有效/],
    [{ to: '2026-11-01' }, 'to', /拍摄结束时间.*有效/],
    [
      { from: '2026-11-03T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' },
      'from/to',
      /拍摄开始时间、拍摄结束时间.*必须早于/,
    ],
    [{ type: 'secret' }, 'type', /照片类型.*请选择/],
    [{ order: 'secret' }, 'order', /排序.*请选择/],
  ]) {
    const r = await call(root + '/assets?' + new URLSearchParams(params), u);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.errors[0].path[0], field);
    assert.match(body.errors[0].message, message);
    assert.doesNotMatch(JSON.stringify(body), /sensitive-|secret/);
  }
  for (const field of ['q', 'from', 'to', 'type', 'order']) {
    const r = await call(`${root}/assets?${field}=a&${field}=b`, u);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).errors[0].path[0], field);
  }
});

test('JPEG/PNG/HEIC 使用真正的衍生预览，额度与生成失败返回具体状态', async () => {
  const u = await user();
  for (const [content, mime] of [
    [liveJpeg(pairId()), 'image/jpeg'],
    [
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6N0AAAAASUVORK5CYII=',
        'base64',
      ),
      'image/png',
    ],
    [liveHeic(pairId()), 'image/heic'],
  ]) {
    const p = await seed(u, content, mime);
    for (const size of ['thumbnail', 'preview']) {
      const r = await call(`${root}/assets/${p.id}/preview?size=${size}`, u, 'GET', undefined, {
        'x-test-sync-preview': '1',
      });
      assert.equal(r.status, 200, await r.clone().text());
      assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([255, 216, 255, 217]));
    }
    const r = await call(`${root}/assets/${p.id}/download`, u);
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from(content));
    assert.match(r.headers.get('content-disposition'), /attachment/);
  }
  const p = await seed(u);
  const fail = await call(`${root}/assets/${p.id}/preview`, u, 'GET', undefined, {
    'x-test-images': 'failure',
    'x-test-sync-preview': '1',
  });
  assert.equal(fail.status, 503);
  assert.match((await fail.json()).message, /原件已保存/);
  const quota = await seed(u);
  const r = await call(`${root}/assets/${quota.id}/preview`, u, 'GET', undefined, {
    'x-test-images': 'quota',
    'x-test-sync-preview': '1',
  });
  assert.equal(r.status, 503);
  assert.match((await r.json()).message, /免费转换额度/);
  assert.equal((await call(`${root}/assets/${quota.id}/download`, u)).status, 200);
});
test('Live Photo 只列一项、原件逐份下载、跨账号读取拒绝、整组删除恢复', async () => {
  const u = await user(),
    other = await user(),
    pair = pairId(),
    motion = await seed(u, liveMov(pair), 'video/quicktime', {
      pair,
      type: 'VIDEO',
      visibility: 'hidden',
      filename: 'private.MOV',
    }),
    still = await seed(u, liveJpeg(pair), 'image/jpeg', { pair, video: motion.id });
  const page = await (await call(root + '/assets', u)).json();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].livePhotoVideoId, motion.id);
  const r = await call(`${root}/assets/${still.id}/download?component=motion`, u);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from(motion.content));
  assert.equal((await call(`${root}/assets/${motion.id}/download`, u)).status, 404);
  for (const suffix of ['preview', 'download'])
    assert.equal((await call(`${root}/assets/${still.id}/${suffix}`, other)).status, 404);
  assert.equal((await call('/api/assets', u, 'DELETE', { ids: [still.id] })).status, 204);
  assert.equal((await (await call(root + '/assets?view=trash', u)).json()).items.length, 1);
  assert.equal(
    (await call('/api/trash/restore/assets', u, 'POST', { ids: [still.id] })).status,
    200,
  );
  const n = await db
    .prepare('SELECT COUNT(*) n FROM assets WHERE owner_id=? AND deleted_at IS NULL')
    .bind(u.id)
    .first();
  assert.equal(n.n, 2);
});
test('管理员创建/改名、重复邮箱/字段错误与越权防护，失败事务不留审计或守卫', async () => {
  const operator = await user(true),
    ordinary = await user();
  assert.equal((await call(adminRoot, ordinary)).status, 403);
  const email = randomUUID() + '@example.invalid',
    body = { email, name: '新账号', password };
  let r = await call(adminRoot, operator, 'POST', body);
  assert.equal(r.status, 201, await r.clone().text());
  const target = await r.json();
  const prior = (await db.prepare('SELECT COUNT(*) n FROM web_account_audit').first()).n;
  r = await call(adminRoot, operator, 'POST', body);
  assert.equal(r.status, 409);
  assert.match((await r.json()).message, /邮箱.*已被使用/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM web_account_audit').first()).n, prior);
  assert.equal((await call(adminRoot, operator, 'POST', { ...body, isAdmin: true })).status, 400);
  r = await call(adminRoot, operator, 'POST', { ...body, email: 'bad', password: 'SECRET' });
  assert.equal(r.status, 400);
  const err = await r.json();
  assert.equal(err.errors[0].path[0], 'email');
  assert.doesNotMatch(JSON.stringify(err), /SECRET/);
  r = await call(adminRoot, operator, 'POST', {
    ...body,
    email: randomUUID() + '@example.invalid',
    password: 'SECRET',
  });
  assert.equal(r.status, 400);
  assert.doesNotMatch(await r.text(), /SECRET/);
  assert.equal(
    (await call(`${adminRoot}/${target.id}`, operator, 'PATCH', { name: '已修改' })).status,
    204,
  );
  assert.equal(
    (await db.prepare('SELECT name FROM users WHERE id=?').bind(target.id).first()).name,
    '已修改',
  );
  assert.equal(
    (await call(`${adminRoot}/${operator.id}`, operator, 'PATCH', { disabled: true })).status,
    403,
  );
  assert.equal(
    (await call(adminRoot, operator, 'POST', body, { Origin: 'https://other.invalid' })).status,
    403,
  );
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM web_account_guards').first()).n, 0);
  const data = await (await call(adminRoot + '?q=' + encodeURIComponent(email), operator)).json();
  assert.equal(data.items.length, 1);
  assert.doesNotMatch(JSON.stringify(data), /password_hash|token_hash/);
});
test('停用/启用和密码重置撤销全部会话，保留照片及关系', async () => {
  const operator = await user(true),
    u = await user(),
    p = await seed(u);
  assert.equal(
    (await call(`${adminRoot}/${u.id}`, operator, 'PATCH', { disabled: true })).status,
    204,
  );
  assert.equal((await call(`${root}/assets/${p.id}/download`, u)).status, 401);
  assert.ok(await db.prepare('SELECT id FROM assets WHERE id=?').bind(p.id).first());
  assert.equal(
    (await call(`${adminRoot}/${u.id}`, operator, 'PATCH', { disabled: false })).status,
    204,
  );
  assert.equal((await call(root + '/bootstrap', u)).status, 401);
  let r = await call('/api/auth/login', null, 'POST', { email: u.email, password });
  assert.equal(r.status, 201);
  u.token = (await r.json()).accessToken;
  const next = 'replacement-password-for-web-v1';
  assert.equal(
    (await call(`${adminRoot}/${u.id}/reset-password`, operator, 'POST', { password: next }))
      .status,
    204,
  );
  assert.equal((await call(root + '/bootstrap', u)).status, 401);
  assert.equal(
    (await call('/api/auth/login', null, 'POST', { email: u.email, password })).status,
    401,
  );
  assert.equal(
    (await call('/api/auth/login', null, 'POST', { email: u.email, password: next })).status,
    201,
  );
});
test('本人改密验证旧密码、拒绝跨站，成功后清除 Cookie 和全部会话', async () => {
  const u = await user();
  assert.equal(
    (
      await call(root + '/password', u, 'POST', {
        currentPassword: 'wrong',
        newPassword: 'new-test-password-private',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        root + '/password',
        u,
        'POST',
        { currentPassword: password, newPassword: 'new-test-password-private' },
        { Origin: '' },
      )
    ).status,
    403,
  );
  const r = await call(root + '/password', u, 'POST', {
    currentPassword: password,
    newPassword: 'new-test-password-private',
  });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call(root + '/bootstrap', u)).status, 401);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').bind(u.id).first()).n,
    0,
  );
});
test('提交时重新授权：已撤销的管理员不能靠旧身份写入，事务全部回滚', async () => {
  const actor = await user(true),
    target = await user();
  // Simulate a concurrent revocation immediately before the guarded write batch.
  const r = await call(
    `${adminRoot}/${target.id}`,
    actor,
    'PATCH',
    { name: '不应写入' },
    { 'x-test-revoke-operator': '1' },
  );
  assert.equal(r.status, 403, await r.clone().text());
  assert.equal(
    (await db.prepare('SELECT name FROM users WHERE id=?').bind(target.id).first()).name,
    '网页测试',
  );
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) n FROM web_account_audit WHERE actor_id=?')
        .bind(actor.id)
        .first()
    ).n,
    0,
  );
});

const albumSnapshot = async (u) => (await call(root + '/albums', u)).json();
const organize = async (u, data, headers = {}) =>
  call(root + '/album-transfer', u, 'POST', data, headers);
async function makeAlbum(u, ids = [], name = '整理相册') {
  const result = await call('/api/albums', u, 'POST', { albumName: name, assetIds: ids });
  assert.equal(result.status, 201, await result.clone().text());
  return result.json();
}
async function relations(album) {
  return (
    await db
      .prepare('SELECT asset_id FROM album_assets WHERE album_id=? ORDER BY asset_id')
      .bind(album.id)
      .all()
  ).results.map((row) => row.asset_id);
}
test('相册整理快照只包含本人完整相册、排序资料和版本，拒绝多余查询及未登录', async () => {
  const a = await user(),
    b = await user();
  const own = await makeAlbum(a, [], '旅行'),
    foreign = await makeAlbum(b, [], '私有');
  const snapshot = await albumSnapshot(a);
  assert.deepEqual(
    snapshot.items.map((x) => x.id),
    [own.id],
  );
  assert.match(snapshot.version, /^\d+:\d+$/);
  assert.ok(snapshot.items[0].createdAt && snapshot.items[0].updatedAt);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    new RegExp(foreign.id + '|object_key|token_hash|session_id'),
  );
  assert.equal((await call(root + '/albums', null)).status, 401);
  const bad = await call(root + '/albums?q=bad', a);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).errors[0].path[0], 'q');
});
test('复制与移动整批原子处理重复项、封面及同步，保留其他相册和 Live Photo 两份原件', async () => {
  const u = await user(),
    pair = pairId(),
    motion = await seed(u, liveMov(pair), 'video/quicktime', {
      type: 'VIDEO',
      visibility: 'hidden',
      pair,
    }),
    photo = await seed(u, liveHeic(pair), 'image/heic', { pair, video: motion.id }),
    other = await seed(u);
  const source = await makeAlbum(u, [photo.id, other.id], '来源'),
    target = await makeAlbum(u, [photo.id], '目标'),
    third = await makeAlbum(u, [photo.id], '其他');
  const before = (
    await db.prepare('SELECT * FROM assets WHERE owner_id=? ORDER BY id').bind(u.id).all()
  ).results;
  let version = (await albumSnapshot(u)).version;
  const copied = await organize(u, {
    ids: [photo.id, other.id, other.id],
    sourceAlbumId: source.id,
    targetAlbumId: target.id,
    mode: 'copy',
    version,
  });
  assert.equal(copied.status, 200, await copied.clone().text());
  assert.deepEqual(await copied.json(), { processed: 2, added: 1, alreadyPresent: 1, removed: 0 });
  assert.deepEqual(await relations(source), [photo.id, other.id].sort());
  version = (await albumSnapshot(u)).version;
  const moved = await organize(u, {
    ids: [photo.id],
    sourceAlbumId: source.id,
    targetAlbumId: target.id,
    mode: 'move',
    version,
  });
  assert.equal(moved.status, 200);
  assert.deepEqual(await moved.json(), { processed: 1, added: 0, alreadyPresent: 1, removed: 1 });
  assert.deepEqual(await relations(source), [other.id]);
  assert.deepEqual(await relations(third), [photo.id]);
  const updated = await (await call('/api/albums/' + source.id, u)).json();
  assert.equal(updated.albumThumbnailAssetId, other.id);
  assert.equal(
    (
      await db
        .prepare(
          'SELECT COUNT(*) n FROM album_asset_deletions WHERE owner_id=? AND album_id=? AND asset_id=?',
        )
        .bind(u.id, source.id, photo.id)
        .first()
    ).n,
    1,
  );
  assert.deepEqual(
    (await db.prepare('SELECT * FROM assets WHERE owner_id=? ORDER BY id').bind(u.id).all())
      .results,
    before,
  );
  for (const asset of [photo, motion])
    assert.deepEqual(Buffer.from(await (await bucket.get(asset.key)).arrayBuffer()), asset.content);
  const replay = await organize(u, {
    ids: [photo.id],
    sourceAlbumId: source.id,
    targetAlbumId: target.id,
    mode: 'move',
    version,
  });
  assert.equal(replay.status, 409);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM web_album_transfer_guards').first()).n, 0);
});
test('相册整理校验定位字段，拒绝跨站、同一相册、缺失来源、无效类型、超过1000项及跨账号', async () => {
  const u = await user(),
    foreign = await user(),
    p = await seed(u),
    other = await seed(foreign),
    source = await makeAlbum(u, [p.id]),
    target = await makeAlbum(u),
    outside = await makeAlbum(foreign, [other.id]);
  const data = {
    ids: [p.id],
    sourceAlbumId: source.id,
    targetAlbumId: target.id,
    mode: 'move',
    version: (await albumSnapshot(u)).version,
  };
  for (const [patch, status, key] of [
    [{ targetAlbumId: source.id }, 400, 'targetAlbumId'],
    [{ sourceAlbumId: undefined }, 400, 'sourceAlbumId'],
    [{ mode: ['copy'] }, 400, 'mode'],
    [{ ids: [] }, 400, 'ids'],
    [{ ids: Array(1001).fill(p.id) }, 400, 'ids'],
    [{ version: 'secret-bad-value' }, 400, 'version'],
    [{ targetAlbumId: outside.id }, 404, 'targetAlbumId'],
    [{ sourceAlbumId: outside.id }, 404, 'sourceAlbumId'],
    [{ ids: [other.id] }, 404, 'ids'],
  ]) {
    const result = await organize(u, { ...data, ...patch });
    assert.equal(result.status, status, JSON.stringify(patch));
    const error = await result.json();
    assert.equal(error.errors[0].path[0], key);
    assert.match(error.message, /：/);
    assert.doesNotMatch(error.message, /secret-bad-value/);
  }
  assert.equal((await organize(u, data, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await organize(null, data)).status, 401);
  assert.deepEqual(await relations(source), [p.id]);
  assert.deepEqual(await relations(target), []);
});
test('相册移动提交前撤销、过期、停用、删除目标或版本变化，均保留来源关系', async () => {
  for (const action of ['revoke', 'expire', 'disable', 'target-delete', 'stale']) {
    const u = await user(),
      p = await seed(u),
      source = await makeAlbum(u, [p.id]),
      target = await makeAlbum(u),
      version = (await albumSnapshot(u)).version;
    const result = await organize(
      u,
      { ids: [p.id], sourceAlbumId: source.id, targetAlbumId: target.id, mode: 'move', version },
      {
        'x-test-album-transfer': action,
        'x-test-transfer-session': u.sessionId,
        'x-test-transfer-target': target.id,
      },
    );
    assert.equal(
      result.status,
      action === 'target-delete' ? 404 : action === 'stale' ? 409 : 401,
      action,
    );
    assert.deepEqual(await relations(source), [p.id], action);
    assert.deepEqual(await relations(target), [], action);
    assert.equal(
      (await db.prepare('SELECT COUNT(*) n FROM web_album_transfer_guards').first()).n,
      0,
    );
  }
});
test('移动在写入目标之后失败会回滚新增关系、封面、同步版本和删除日志', async () => {
  const u = await user(),
    p = await seed(u),
    source = await makeAlbum(u, [p.id]),
    target = await makeAlbum(u),
    version = (await albumSnapshot(u)).version;
  const before = (
    await db
      .prepare(
        'SELECT id,thumbnail_asset_id,sync_seq,touch_revision FROM albums WHERE owner_id=? ORDER BY id',
      )
      .bind(u.id)
      .all()
  ).results;
  await db
    .prepare(
      `CREATE TRIGGER test_transfer_rollback BEFORE DELETE ON album_assets WHEN OLD.album_id='${source.id}' BEGIN SELECT RAISE(ABORT,'TEST_TRANSFER_ROLLBACK'); END`,
    )
    .run();
  try {
    const result = await organize(u, {
      ids: [p.id],
      sourceAlbumId: source.id,
      targetAlbumId: target.id,
      mode: 'move',
      version,
    });
    assert.equal(result.status, 503);
  } finally {
    await db.prepare('DROP TRIGGER test_transfer_rollback').run();
  }
  assert.deepEqual(await relations(source), [p.id]);
  assert.deepEqual(await relations(target), []);
  assert.equal((await albumSnapshot(u)).version, version);
  assert.deepEqual(
    (
      await db
        .prepare(
          'SELECT id,thumbnail_asset_id,sync_seq,touch_revision FROM albums WHERE owner_id=? ORDER BY id',
        )
        .bind(u.id)
        .all()
    ).results,
    before,
  );
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) n FROM album_asset_deletions WHERE owner_id=?')
        .bind(u.id)
        .first()
    ).n,
    0,
  );
});
test('相册整理支持1000张批量移动，无遗漏或重复，隐藏动态及回收项不能直接整理', async () => {
  const u = await user(),
    ids = [];
  for (let at = 0; at < 1000; at += 50)
    await db.batch(
      Array.from({ length: 50 }, (_, n) => {
        const id = randomUUID();
        ids.push(id);
        const date = '2026-11-11T00:00:00.000Z';
        return db
          .prepare(
            "INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES(?,?,?,?,?,'image/jpeg',4,1,1,?,?,?,0)",
          )
          .bind(id, u.id, id, id, 'batch-' + (at + n) + '.jpg', date, date, date);
      }),
    );
  const source = await makeAlbum(u, ids),
    target = await makeAlbum(u),
    version = (await albumSnapshot(u)).version;
  const moved = await organize(u, {
    ids,
    sourceAlbumId: source.id,
    targetAlbumId: target.id,
    mode: 'move',
    version,
  });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal((await moved.json()).processed, 1000);
  assert.deepEqual(await relations(source), []);
  assert.deepEqual(await relations(target), [...ids].sort());
  const trashed = await seed(u);
  await call('/api/assets', u, 'DELETE', { ids: [trashed.id] });
  const hidden = await seed(u, liveMov(pairId()), 'video/quicktime', {
    type: 'VIDEO',
    visibility: 'hidden',
  });
  for (const id of [trashed.id, hidden.id]) {
    const response = await organize(u, {
      ids: [id],
      targetAlbumId: target.id,
      mode: 'copy',
      version: (await albumSnapshot(u)).version,
    });
    assert.equal(response.status, 404);
  }
});

const archiveVersion = async (u) =>
  (await (await call(root + '/assets?view=library&limit=1', u)).json()).version;
const setArchive = async (u, ids, archived, version, headers = {}) =>
  call(
    root + '/archive',
    u,
    'PATCH',
    { ids, archived, version: version ?? (await archiveVersion(u)) },
    headers,
  );
const archiveList = async (u, view = 'archive', suffix = '') =>
  (await (await call(root + '/assets?view=' + view + '&limit=100' + suffix, u)).json()).items;

test('照片归档单张/取消保持原件、收藏和相册，时间线隐藏但搜索/选图及归档可见', async () => {
  const u = await user(true),
    a = await seed(u),
    b = await seed(u),
    album = await makeAlbum(u, [a.id]);
  await call('/api/assets/' + a.id, u, 'PUT', { isFavorite: true });
  const original = await db.prepare('SELECT * FROM assets WHERE id=?').bind(a.id).first(),
    quota = await (await call(root + '/bootstrap', u)).json();
  const response = await setArchive(u, [a.id], true);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { processed: 1, changed: 1, unchanged: 0 });
  assert.deepEqual(
    (await archiveList(u)).map((p) => p.id),
    [a.id],
  );
  assert.deepEqual(
    (await archiveList(u, 'photos')).map((p) => p.id),
    [b.id],
  );
  assert.equal((await archiveList(u, 'favorites')).find((p) => p.id === a.id).isArchived, true);
  assert.equal((await archiveList(u, 'album', '&albumId=' + album.id))[0].id, a.id);
  assert.equal((await archiveList(u, 'photos', '&q=private-photo')).length, 2);
  assert.equal((await archiveList(u, 'library')).length, 2);
  const detail = await (await call('/api/assets/' + a.id, u)).json();
  assert.equal(detail.visibility, 'archive');
  assert.equal(detail.isArchived, true);
  const row = await db.prepare('SELECT * FROM assets WHERE id=?').bind(a.id).first();
  for (const key of [
    'object_key',
    'checksum',
    'bytes',
    'favorite',
    'file_created_at',
    'file_modified_at',
    'metadata',
    'live_photo_video_id',
  ])
    assert.deepEqual(row[key], original[key], key);
  assert.ok(row.sync_seq > original.sync_seq);
  assert.equal(
    (await (await call(root + '/bootstrap', u)).json()).usage.logicalBytes,
    quota.usage.logicalBytes,
  );
  assert.deepEqual(Buffer.from(await (await bucket.get(a.key)).arrayBuffer()), a.content);
  const exported = await (await call('/api/immich-cf/admin/export/page?userId=' + u.id, u)).json();
  assert.equal(exported.page.items.find((p) => p.id === a.id).archived, 1);
  const version = await archiveVersion(u),
    noop = await setArchive(u, [a.id], true, version);
  assert.deepEqual(await noop.json(), { processed: 1, changed: 0, unchanged: 1 });
  assert.equal(await archiveVersion(u), version);
  assert.equal((await setArchive(u, [a.id], false)).status, 200);
  assert.equal((await archiveList(u)).length, 0);
  assert.equal((await archiveList(u, 'photos')).length, 2);
});
test('照片归档整批字段/权限校验不部分提交，回收与隐藏动态不可归档', async () => {
  const u = await user(),
    foreign = await user(),
    a = await seed(u),
    b = await seed(foreign),
    hidden = await seed(u, liveMov(pairId()), 'video/quicktime', {
      type: 'VIDEO',
      visibility: 'hidden',
    }),
    trashed = await seed(u);
  await call('/api/assets', u, 'DELETE', { ids: [trashed.id] });
  const version = await archiveVersion(u);
  for (const [patch, status, key] of [
    [{ ids: [a.id, b.id] }, 404, 'ids'],
    [{ ids: [a.id, randomUUID()] }, 404, 'ids'],
    [{ ids: [a.id, hidden.id] }, 404, 'ids'],
    [{ ids: [a.id, trashed.id] }, 404, 'ids'],
    [{ ids: [] }, 400, 'ids'],
    [{ ids: Array(1001).fill(a.id) }, 400, 'ids'],
    [{ archived: 'true' }, 400, 'archived'],
    [{ archived: null }, 400, 'archived'],
    [{ version: 'private-submit-value' }, 400, 'version'],
    [{ unknown: true }, 400, 'unknown'],
  ]) {
    const r = await call(root + '/archive', u, 'PATCH', {
      ids: [a.id],
      archived: true,
      version,
      ...patch,
    });
    assert.equal(r.status, status);
    const error = await r.json();
    assert.equal(error.errors[0].path[0], key);
    assert.doesNotMatch(error.message, /private-submit-value/);
    assert.equal(
      (await db.prepare('SELECT archived FROM assets WHERE id=?').bind(a.id).first()).archived,
      0,
    );
  }
  assert.equal(
    (await setArchive(u, [a.id], true, version, { Origin: 'https://foreign.invalid' })).status,
    403,
  );
  assert.equal(
    (await call(root + '/archive', null, 'PATCH', { ids: [a.id], archived: true, version })).status,
    401,
  );
  const duplicate = await setArchive(u, [a.id, a.id.toUpperCase()], true);
  assert.equal((await duplicate.json()).processed, 1);
});
test('照片归档提交时会话撤销/过期/停用或版本变化，整批照片保持原状态', async () => {
  for (const action of ['revoke', 'expire', 'disable', 'stale']) {
    const u = await user(),
      a = await seed(u),
      b = await seed(u),
      album = await makeAlbum(u),
      version = await archiveVersion(u);
    const result = await setArchive(u, [a.id, b.id], true, version, {
      'x-test-album-transfer': action,
      'x-test-transfer-session': u.sessionId,
      'x-test-transfer-target': album.id,
    });
    assert.equal(result.status, action === 'stale' ? 409 : 401, action);
    assert.equal(
      (await db.prepare('SELECT SUM(archived) n FROM assets WHERE owner_id=?').bind(u.id).first())
        .n,
      0,
    );
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM photo_archive_guards').first()).n, 0);
  }
});
test('照片归档中途故障回滚已更新照片、同步版本及临时守卫', async () => {
  const u = await user(),
    a = await seed(u),
    b = await seed(u),
    version = await archiveVersion(u);
  const before = (
    await db.prepare('SELECT * FROM assets WHERE owner_id=? ORDER BY id').bind(u.id).all()
  ).results;
  await db
    .prepare(
      `CREATE TRIGGER test_archive_rollback AFTER UPDATE OF archived ON assets WHEN NEW.owner_id='${u.id}' AND (SELECT SUM(archived) FROM assets WHERE owner_id=NEW.owner_id)=2 BEGIN SELECT RAISE(ABORT,'TEST_ARCHIVE_ROLLBACK'); END`,
    )
    .run();
  try {
    assert.equal((await setArchive(u, [a.id, b.id], true, version)).status, 503);
  } finally {
    await db.prepare('DROP TRIGGER test_archive_rollback').run();
  }
  assert.deepEqual(
    (await db.prepare('SELECT * FROM assets WHERE owner_id=? ORDER BY id').bind(u.id).all())
      .results,
    before,
  );
  assert.equal(await archiveVersion(u), version);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM photo_archive_guards').first()).n, 0);
});
test('照片归档1001张合成图库的1000张整批、日期定位、双向排序、分页去重及版本/账号隔离', async () => {
  const u = await user(),
    foreign = await user(),
    ids = [];
  for (let at = 0; at < 1001; at += 50)
    await db.batch(
      Array.from({ length: Math.min(50, 1001 - at) }, (_, n) => {
        const id = randomUUID();
        ids.push(id);
        const date = new Date(
          Date.UTC(2020 + Math.floor((at + n) / 365), Math.floor((at + n) / 30) % 12, 1),
        ).toISOString();
        return db
          .prepare(
            "INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite) VALUES(?,?,?,?,?,'image/jpeg',4,1,1,?,?,?,?)",
          )
          .bind(
            id,
            u.id,
            id,
            id,
            'archive-test-' + (at + n) + '.jpg',
            date,
            date,
            date,
            (at + n) % 2,
          );
      }),
    );
  assert.equal((await setArchive(u, ids.slice(0, 1000), true)).status, 200);
  assert.equal((await archiveList(u, 'photos')).length, 1);
  const total = [];
  let cursor;
  let first;
  do {
    const r = await call(
      root +
        '/assets?view=archive&limit=60' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      u,
    );
    assert.equal(r.status, 200);
    const page = await r.json();
    first ??= page;
    total.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(total.length, 1000);
  assert.equal(new Set(total.map((p) => p.id)).size, 1000);
  assert.ok(total.every((p) => p.isArchived && p.visibility === 'archive'));
  assert.equal(
    (await call(root + '/assets?view=photos&cursor=' + encodeURIComponent(first.nextCursor), u))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        root + '/assets?view=archive&cursor=' + encodeURIComponent(first.nextCursor),
        foreign,
      )
    ).status,
    400,
  );
  const overview = await (
    await call(root + '/timeline?view=archive&timeZone=Asia%2FShanghai', u)
  ).json();
  assert.equal(
    overview.months.reduce((n, m) => n + m.count, 0),
    1000,
  );
  const month = overview.months[Math.floor(overview.months.length / 2)];
  const sought = await (
    await call(
      root +
        '/assets?view=archive&anchorId=' +
        month.anchorId +
        '&anchorTime=' +
        encodeURIComponent(month.anchorTime),
      u,
    )
  ).json();
  assert.equal(sought.items[0].id, month.anchorId);
  assert.ok(sought.previousCursor && sought.nextCursor);
  const asc = await archiveList(u, 'archive', '&order=oldest');
  assert.equal(asc[0].id, total.at(-1).id);
  assert.equal((await archiveList(u, 'archive', '&q=archive-test-1000')).length, 0);
  assert.ok((await archiveList(u, 'archive', '&type=jpeg')).length > 0);
  assert.equal((await setArchive(u, [ids[0]], false)).status, 200);
  assert.equal(
    (await call(root + '/assets?view=archive&cursor=' + encodeURIComponent(first.nextCursor), u))
      .status,
    409,
  );
  assert.equal((await setArchive(u, ids.slice(0, 1000), false)).status, 200);
  assert.equal((await archiveList(u)).length, 0);
  assert.equal(
    (await (await call(root + '/timeline?view=photos&timeZone=UTC', u)).json()).months.reduce(
      (n, m) => n + m.count,
      0,
    ),
    1001,
  );
});
test('照片归档保持 Live Photo 配对、分享下载及相册整理，删除恢复后仍为归档', async () => {
  const u = await user(),
    pair = pairId(),
    motion = await seed(u, liveMov(pair), 'video/quicktime', {
      pair,
      type: 'VIDEO',
      visibility: 'hidden',
    }),
    photo = await seed(u, liveHeic(pair), 'image/heic', { pair, video: motion.id }),
    album = await makeAlbum(u, [photo.id]);
  const link = await (
    await call(shares, u, 'POST', { albumId: album.id, days: 1, allowDownload: true })
  ).json();
  assert.equal((await setArchive(u, [photo.id], true)).status, 200);
  assert.equal(
    (await db.prepare('SELECT archived FROM assets WHERE id=?').bind(motion.id).first()).archived,
    0,
  );
  assert.equal((await archiveList(u, 'archive', '&type=live')).length, 1);
  const header = { Authorization: 'Share ' + link.path.split('#')[1] };
  assert.equal(
    (await (await call(shared, null, 'GET', undefined, header)).json()).items[0].id,
    photo.id,
  );
  for (const [id, component, content] of [
    [photo.id, 'photo', photo.content],
    [photo.id, 'motion', motion.content],
  ]) {
    const r = await call(root + '/assets/' + id + '/download?component=' + component, u);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), content);
  }
  const zip = await prepareZip(u, { albumId: album.id });
  assert.equal(zip.status, 200);
  assert.equal((await zip.json()).files, 2);
  const target = await makeAlbum(u);
  const copied = await organize(u, {
    ids: [photo.id],
    targetAlbumId: target.id,
    sourceAlbumId: album.id,
    mode: 'copy',
    version: await archiveVersion(u),
  });
  assert.equal(copied.status, 200);
  await call('/api/assets', u, 'DELETE', { ids: [photo.id] });
  assert.equal((await archiveList(u)).length, 0);
  assert.equal((await archiveList(u, 'trash'))[0].isArchived, true);
  await call('/api/trash/restore/assets', u, 'POST', { ids: [photo.id] });
  assert.equal((await archiveList(u)).length, 1);
  assert.equal((await archiveList(u, 'photos')).length, 0);
  assert.equal((await archiveList(u, 'album', '&albumId=' + album.id)).length, 1);
  assert.deepEqual(Buffer.from(await (await bucket.get(motion.key)).arrayBuffer()), motion.content);
});
test('照片归档按冻结可见性字段兼容官方单张/批量写入、统计及初始/增量 Sync', async () => {
  const u = await user(),
    a = await seed(u),
    b = await seed(u),
    album = await makeAlbum(u, [a.id, b.id]);
  const stream = async (reset = false) => {
    const r = await call('/api/sync/stream', u, 'POST', {
      types: ['AssetsV2', 'AlbumAssetsV2'],
      reset,
    });
    assert.equal(r.status, 200);
    const events = (await r.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'SyncCompleteV1');
    return events;
  };
  const first = await stream(true);
  await call('/api/sync/ack', u, 'POST', { acks: first.map((e) => e.ack) });
  const saved = await call('/api/assets/' + a.id, u, 'PUT', {
    visibility: 'archive',
    isFavorite: true,
  });
  assert.equal(saved.status, 200);
  const detail = await saved.json();
  assert.equal(detail.isArchived, true);
  assert.equal(detail.visibility, 'archive');
  assert.equal(detail.isFavorite, true);
  const delta = await stream();
  assert.ok(
    delta.some(
      (e) => e.type === 'AssetV2' && e.data.id === a.id && e.data.visibility === 'archive',
    ),
  );
  assert.ok(
    delta.some(
      (e) =>
        e.type === 'AlbumAssetUpdateV2' && e.data.id === a.id && e.data.visibility === 'archive',
    ),
  );
  assert.equal(
    (await (await call('/api/assets/statistics?visibility=archive', u)).json()).total,
    1,
  );
  assert.equal((await (await call('/api/assets/statistics', u)).json()).total, 1);
  assert.equal((await (await call('/api/assets/statistics?isFavorite=true', u)).json()).total, 1);
  assert.equal(
    (await call('/api/assets', u, 'PUT', { ids: [a.id, b.id], visibility: 'archive' })).status,
    204,
  );
  for (const visibility of ['hidden', 'locked', {}, [], null, 42]) {
    const invalid = await call('/api/assets/' + a.id, u, 'PUT', { visibility });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).errors[0].path[0], 'visibility');
  }
  assert.equal(
    (await call('/api/assets', u, 'PUT', { ids: [a.id, b.id], visibility: 'timeline' })).status,
    204,
  );
  assert.equal((await archiveList(u)).length, 0);
  assert.equal((await archiveList(u, 'album', '&albumId=' + album.id)).length, 2);
});
