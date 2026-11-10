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
test('网页入口与深链接可用，API/未知路径不回落 HTML，未登录数据私有', async () => {
  for (const route of ['/', '/photos', '/albums', '/account', '/admin/users']) {
    const r = await call(route);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /html/);
    assert.match(await r.text(), /lang="zh-CN"/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
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
  assert.equal(data.limits.upload.photoBytes, 20_000_000);
  assert.equal(data.limits.upload.motionBytes, 64 * 1024 ** 2);
  assert.equal(data.user.id, u.id);
  assert.doesNotMatch(JSON.stringify(data), /password_hash|token_hash|object_key/);
  assert.equal((await (await call('/api/users/me', u)).json()).isAdmin, false);
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
