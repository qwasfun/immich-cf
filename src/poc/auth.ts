import bcrypt from 'bcryptjs';
import { body, digest, HttpError, invalid } from './http';

export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
  update_id: string;
  disabled: number;
  quota_usage?: number;
  asset_revision?: number;
}
export interface Identity extends User {
  session_id: string;
  expires_at: number;
  reset_pending: number;
}
// 已知非账户哈希：未知账户也执行同等 cost，避免快速返回暴露账户存在性。
const DUMMY_HASH = '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';

export function userDto(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarColor: 'primary',
    clusterGroupId: user.id,
    createdAt: user.created_at,
    updatedAt: user.created_at,
    deletedAt: null,
    isAdmin: false,
    license: null,
    oauthId: '',
    profileChangedAt: user.created_at,
    profileImagePath: '',
    quotaSizeInBytes: null,
    quotaUsageInBytes: user.quota_usage ?? 0,
    shouldChangePassword: false,
    status: 'active',
    storageLabel: null,
  };
}

export async function login(request: Request, db: D1Database) {
  const input = await body(request);
  if (
    typeof input.email !== 'string' ||
    input.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())
  )
    invalid('email', '请填写有效邮箱，最多 254 字符');
  if (
    typeof input.password !== 'string' ||
    !input.password.length ||
    bcrypt.truncates(input.password)
  )
    invalid('password', '不能为空，且 UTF-8 编码后不得超过 72 字节');
  const email = input.email.trim().toLowerCase();
  const now = Date.now();
  // IP 由 Cloudflare 提供；不信任 X-Forwarded-For。摘要键不保存邮箱或 IP 明文。
  const keys = await Promise.all(
    [`account:${email}`, `ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`].map((v) =>
      digest(v),
    ),
  );
  const limits = await db.batch<{ count: number }>(
    keys.map((key) =>
      db
        .prepare(
          'INSERT INTO login_buckets (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING count',
        )
        .bind(key, now + 60000, now, now),
    ),
  );
  if (limits.some((r, i) => (r.results[0]?.count ?? 999) > (i === 0 ? 5 : 20)))
    throw new HttpError(429, '登录尝试过多，请一分钟后重试');
  await db.prepare('DELETE FROM login_buckets WHERE expires_at < ?').bind(now).run();
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
  const valid = await bcrypt.compare(input.password, user?.password_hash ?? DUMMY_HASH);
  if (!valid || !user || user.disabled) throw new HttpError(401, '邮箱或密码不正确，请核对后重试');
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
  const expires = now + 7 * 86400000;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db
      .prepare(
        'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(crypto.randomUUID(), user.id, await digest(token), expires, now, now),
  ]);
  return { token, expires, user };
}

export async function authenticate(request: Request, db: D1Database): Promise<Identity> {
  const authorization = request.headers.get('authorization');
  const cookies = (request.headers.get('cookie') ?? '').split(';').map((v) => v.trim());
  const values = cookies
    .filter((v) => v.startsWith('immich_access_token='))
    .map((v) => v.slice('immich_access_token='.length));
  const bearer = authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if (
    (authorization && !bearer) ||
    values.length > 1 ||
    (bearer && values[0] && bearer !== values[0])
  )
    throw new HttpError(401, '会话无效，请重新登录');
  const token = bearer ?? values[0];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, '请先登录');
  const identity = await db
    .prepare(
      'SELECT users.*, sessions.id AS session_id, sessions.expires_at, sessions.reset_pending, (SELECT COALESCE(SUM(bytes),0) FROM assets WHERE owner_id = users.id) AS quota_usage, (SELECT COALESCE(MAX(seq),0) FROM assets WHERE owner_id = users.id) AS asset_revision FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ? AND disabled = 0',
    )
    .bind(await digest(token), Date.now())
    .first<Identity>();
  if (!identity) throw new HttpError(401, '会话已失效，请重新登录');
  // 使用 Cookie 的浏览器写请求须为同源；无 Origin 的原生 App 请求仍可用。
  const origin = request.headers.get('origin');
  if (
    values.length &&
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    origin &&
    origin !== new URL(request.url).origin
  )
    throw new HttpError(403, '请求来源无效，请从当前服务重新操作');
  return identity;
}

export function cookies(request: Request, token: string, clear = false): string[] {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return [
    ['immich_access_token', token, true],
    ['immich_is_authenticated', clear ? '' : 'true', false],
    ['immich_auth_type', clear ? '' : 'password', true],
  ].map(
    ([name, value, httpOnly]) =>
      `${name}=${value}; Path=/; SameSite=Lax; Max-Age=${clear ? 0 : 604800}${httpOnly ? '; HttpOnly' : ''}${secure}`,
  );
}
