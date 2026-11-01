import bcrypt from 'bcryptjs';
import { authenticate, cookies, type Identity } from '../poc/auth';
import { requireOperator } from '../poc/admin';
import { body, HttpError, invalid, uuid7 } from '../poc/http';
import { decode, encode, field, only, pageSize, sameOrigin, uuid } from './common';

function name(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 80 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    field('name', '显示名称', '请填写 1～80 个字符，不能包含控制字符');
  return value.trim();
}
function password(value: unknown, key = 'password') {
  if (typeof value !== 'string' || Array.from(value).length < 15 || bcrypt.truncates(value))
    field(
      key,
      key === 'newPassword' ? '新密码' : '密码',
      '至少 15 个字符，且 UTF-8 编码后最多 72 字节',
    );
  return value;
}
function email(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    field('email', '邮箱', '请填写有效邮箱，最多 254 个字符');
  return value.trim().toLowerCase();
}

async function commit(
  db: D1Database,
  identity: Identity,
  target: string,
  action: string,
  statements: D1PreparedStatement[],
  verifiedHash: string | null = null,
) {
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare('INSERT INTO web_account_guards VALUES(?,?,?,?,?,?,?)')
        .bind(id, identity.id, identity.session_id, target, action, Date.now(), verifiedHash),
      ...statements,
      db.prepare('DELETE FROM web_account_guards WHERE id=?').bind(id),
    ]);
  } catch (error) {
    const message = String(error);
    if (message.includes('WEB_SESSION')) throw new HttpError(401, '会话已失效，请重新登录');
    if (message.includes('WEB_ADMIN'))
      throw new HttpError(403, '管理员权限已失效，请联系部署维护者');
    if (message.includes('WEB_OPERATOR_TARGET'))
      throw new HttpError(
        403,
        '目标账号：网页只能管理普通账号；管理员请使用维护流程或自行修改密码',
        'userId',
      );
    if (message.includes('WEB_TARGET'))
      throw new HttpError(404, '目标账号：账号不存在，请刷新列表', 'userId');
    if (message.includes('WEB_PASSWORD_CHANGED'))
      throw new HttpError(409, '旧密码：账号状态已变化，请重新登录后再修改', 'currentPassword');
    if (message.includes('UNIQUE constraint failed: users.email'))
      throw new HttpError(409, '邮箱：已被使用，请填写其他邮箱', 'email');
    throw new HttpError(503, '账号操作：提交结果暂不可确认，请先刷新账号状态再操作');
  }
}

export async function changePassword(request: Request, env: Env, identity: Identity) {
  sameOrigin(request);
  const input = await body(request);
  only(input, ['currentPassword', 'newPassword']);
  if (
    typeof input.currentPassword !== 'string' ||
    !input.currentPassword ||
    bcrypt.truncates(input.currentPassword)
  )
    field('currentPassword', '旧密码', '请填写当前密码，UTF-8 编码后最多 72 字节');
  const next = password(input.newPassword, 'newPassword');
  if (!(await bcrypt.compare(input.currentPassword, identity.password_hash)))
    field('currentPassword', '旧密码', '不正确，请核对当前密码');
  if (next === input.currentPassword)
    field('newPassword', '新密码', '不能与旧密码相同，请设置其他密码');
  const db = env.IMMICH_CF_DB;
  await commit(
    db,
    identity,
    identity.id,
    'change-password',
    [
      db
        .prepare('UPDATE users SET password_hash=?,update_id=? WHERE id=?')
        .bind(await bcrypt.hash(next, 12), uuid7(), identity.id),
      db.prepare('DELETE FROM sessions WHERE user_id=?').bind(identity.id),
    ],
    identity.password_hash,
  );
  const response = Response.json({ message: '密码已修改，网页和 App 均需重新登录' });
  for (const cookie of cookies(request, '', true)) response.headers.append('Set-Cookie', cookie);
  return response;
}

export async function accounts(request: Request, env: Env, identity: Identity) {
  const db = env.IMMICH_CF_DB,
    url = new URL(request.url);
  await requireOperator(db, identity);
  const match = url.pathname.match(
    /^\/api\/immich-cf\/admin\/users(?:\/([^/]+)(?:\/(reset-password|sessions))?)?$/,
  )!;
  const id = match[1] ? uuid(match[1], 'userId') : undefined;
  if (request.method === 'GET') {
    for (const key of url.searchParams.keys())
      if (!['q', 'cursor', 'limit'].includes(key)) invalid(key, '此查询参数不受支持，请移除');
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q.length > 80) field('q', '账号搜索', '最多填写 80 个字符');
    const limit = pageSize(url.searchParams),
      raw = url.searchParams.get('cursor');
    let after = '';
    if (raw) {
      const c = decode<{ owner: string; q: string; after: string }>(raw);
      if (!c || c.owner !== identity.id || c.q !== q || typeof c.after !== 'string')
        invalid('cursor', '游标与当前账号或筛选不符，请刷新列表');
      after = uuid(c.after, 'cursor');
    }
    const rows = await db
      .prepare(
        `SELECT u.id,u.email,u.name,u.disabled,u.created_at createdAt,EXISTS(SELECT 1 FROM operations_admins WHERE user_id=u.id) isOperator,
      COALESCE((SELECT logical_assets FROM asset_owner_usage WHERE owner_id=u.id),0) logicalAssets,
      (SELECT COALESCE(SUM(bytes),0) FROM assets WHERE owner_id=u.id) logicalBytes,
      (SELECT COUNT(*) FROM assets WHERE owner_id=u.id AND visibility='timeline' AND deleted_at IS NOT NULL) trashed,
      (SELECT COUNT(*) FROM sessions WHERE user_id=u.id AND expires_at>?) sessions,
      (SELECT logical_limit FROM asset_quota_config WHERE id=1) assetLimit
      FROM users u WHERE u.id>? AND (?='' OR instr(lower(u.email),lower(?))>0 OR instr(lower(u.name),lower(?))>0) ORDER BY u.id LIMIT ?`,
      )
      .bind(Date.now(), after, q, q, q, limit + 1)
      .all<{ id: string }>();
    await requireOperator(db, identity);
    const items = rows.results.slice(0, limit);
    return Response.json({
      items,
      nextCursor:
        rows.results.length > limit
          ? encode({ owner: identity.id, q, after: items.at(-1)!.id })
          : null,
    });
  }
  sameOrigin(request);
  const input = await body(request, request.method === 'DELETE');
  if (!id) {
    only(input, ['email', 'name', 'password']);
    const target = crypto.randomUUID(),
      loginEmail = email(input.email),
      displayName = name(input.name),
      hash = await bcrypt.hash(password(input.password), 12);
    await commit(db, identity, target, 'create', [
      db
        .prepare(
          'INSERT INTO users(id,email,name,password_hash,created_at,update_id) VALUES(?,?,?,?,?,?)',
        )
        .bind(target, loginEmail, displayName, hash, new Date().toISOString(), uuid7()),
    ]);
    return Response.json({ id: target, email: loginEmail, name: displayName }, { status: 201 });
  }
  if (match[2] === 'reset-password') {
    only(input, ['password']);
    const hash = await bcrypt.hash(password(input.password), 12);
    await commit(db, identity, id, 'reset-password', [
      db.prepare('UPDATE users SET password_hash=?,update_id=? WHERE id=?').bind(hash, uuid7(), id),
      db.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
    ]);
  } else if (match[2] === 'sessions') {
    only(input, []);
    await commit(db, identity, id, 'revoke-sessions', [
      db.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
    ]);
  } else {
    only(input, ['name', 'disabled']);
    if (Object.keys(input).length !== 1)
      field('name/disabled', '名称/账号状态', '每次只修改名称或账号状态中的一项');
    if (Object.hasOwn(input, 'name')) {
      await commit(db, identity, id, 'rename', [
        db
          .prepare('UPDATE users SET name=?,update_id=? WHERE id=?')
          .bind(name(input.name), uuid7(), id),
      ]);
    } else {
      if (typeof input.disabled !== 'boolean') field('disabled', '账号状态', '必须选择启用或停用');
      await commit(db, identity, id, input.disabled ? 'disable' : 'enable', [
        db
          .prepare('UPDATE users SET disabled=?,update_id=? WHERE id=?')
          .bind(input.disabled ? 1 : 0, uuid7(), id),
        db.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
      ]);
    }
  }
  // A successful transaction is sufficient even if a separate request revokes the actor afterwards.
  return new Response(null, { status: 204 });
}

export async function webBootstrap(request: Request, env: Env, identity: Identity) {
  const db = env.IMMICH_CF_DB;
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT COALESCE((SELECT logical_assets FROM asset_owner_usage WHERE owner_id=?),0) logicalAssets,(SELECT COALESCE(SUM(bytes),0) FROM assets WHERE owner_id=?) logicalBytes',
      )
      .bind(identity.id, identity.id),
    db.prepare('SELECT 1 FROM operations_admins WHERE user_id=?').bind(identity.id),
    db.prepare('SELECT logical_limit assetLimit FROM asset_quota_config WHERE id=1'),
    db
      .prepare(
        "SELECT COUNT(*) photos,COALESCE(SUM(deleted_at IS NOT NULL),0) trashed FROM assets WHERE owner_id=? AND media_type='IMAGE' AND visibility='timeline'",
      )
      .bind(identity.id),
  ]);
  await authenticate(request, db);
  return Response.json({
    user: { id: identity.id, email: identity.email, name: identity.name },
    canManageAccounts: results[1]!.results.length > 0,
    usage: { ...results[0]!.results[0], ...results[3]!.results[0] },
    limits: { ...results[2]!.results[0], logicalAssetsIncludeTrashAndReservations: true },
    support: {
      upload: false,
      share: false,
      previewFormats: ['image/jpeg', 'image/png', 'image/heic'],
      livePhotoPlayback: 'browser-dependent',
    },
  });
}
