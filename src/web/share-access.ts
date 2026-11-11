import bcrypt from 'bcryptjs';
import { body, digest, HttpError } from '../poc/http';
import { only, sameOrigin } from './common';
import { sharePasswordError } from './share-password';

export const joined = 'FROM web_shares s JOIN users u ON u.id=s.owner_id';
export const active = 's.token_hash=? AND s.expires_ms>? AND u.disabled=0';
export const unlocked = `(s.password_hash IS NULL OR EXISTS(
  SELECT 1 FROM web_share_access g WHERE g.token_hash=? AND g.share_id=s.id AND g.expires_ms>?))`;

export function unavailable(): never {
  throw new HttpError(404, '分享链接无效、已过期或已撤销，请向分享者索取新链接');
}
export function passwordRequired(): never {
  throw new HttpError(401, '访问密码：请输入密码解锁分享', 'password');
}
export function parseSharePassword(value: unknown): string {
  const error = sharePasswordError(value);
  if (error) throw new HttpError(400, error, 'password');
  return value as string;
}
export function shareSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function shareCredentials(request: Request) {
  const auth = /^Share ([a-f0-9]{64})(?:\.([a-f0-9]{64}))?$/.exec(
    request.headers.get('Authorization') ?? '',
  );
  if (!auth) unavailable();
  return {
    link: await digest(auth[1]!),
    guest: auth[2] ? await digest(auth[2]) : '',
  };
}

export async function unlockShare(request: Request, db: D1Database) {
  sameOrigin(request);
  const { link } = await shareCredentials(request);
  const input = await body(request, false, 2048);
  only(input, ['password']);
  const password = parseSharePassword(input.password);
  const now = Date.now();
  const share = await db
    .prepare(`SELECT s.id,s.password_hash ${joined} WHERE ${active}`)
    .bind(link, now)
    .first<{ id: string; password_hash: string | null }>();
  if (!share) unavailable();
  if (!share.password_hash)
    throw new HttpError(409, '访问密码：该链接无需密码，请刷新分享页面', 'password');

  // Reserve a verification before bcrypt so concurrent requests share the same attempt limit.
  const bucket = await db
    .prepare(
      `INSERT INTO web_share_unlock_limits(share_id,attempts,reset_ms)
      SELECT s.id,1,? ${joined} WHERE ${active} AND s.password_hash=?
      ON CONFLICT(share_id) DO UPDATE SET
        attempts=CASE WHEN reset_ms<=? THEN 1 ELSE MIN(attempts+1,6) END,
        reset_ms=CASE WHEN reset_ms<=? THEN excluded.reset_ms ELSE reset_ms END
      RETURNING attempts`,
    )
    .bind(now + 60000, link, now, share.password_hash, now, now)
    .first<{ attempts: number }>();
  if (!bucket) passwordRequired();
  if (bucket.attempts > 5)
    throw new HttpError(429, '访问密码：尝试过多，请一分钟后重试', 'password');
  if (!(await bcrypt.compare(password, share.password_hash)))
    throw new HttpError(403, '访问密码：密码不正确，请核对后重试', 'password');

  const accessToken = shareSecret();
  const tokenHash = await digest(accessToken);
  const checkedAt = Date.now();
  const issued = await db
    .prepare(
      `INSERT INTO web_share_access(token_hash,share_id,expires_ms)
      SELECT ?,s.id,MIN(s.expires_ms,?) ${joined} WHERE ${active} AND s.password_hash=?
      RETURNING expires_ms`,
    )
    .bind(tokenHash, checkedAt + 4 * 3600000, link, checkedAt, share.password_hash)
    .first();
  if (!issued) passwordRequired();
  return Response.json({ accessToken });
}
