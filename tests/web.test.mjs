import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
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
  assert.equal(data.user.id, u.id);
  assert.doesNotMatch(JSON.stringify(data), /password_hash|token_hash|object_key/);
  assert.equal((await (await call('/api/users/me', u)).json()).isAdmin, false);
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
