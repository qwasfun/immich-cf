import type { Identity } from './auth';
import { HttpError, invalid } from './http';

export function isStorageCopyKey(key: string, owner: string) {
  return (
    /^[a-f0-9-]{36}\/[a-f0-9-]{36}\/verified-sha1-[a-f0-9]{40}$/.test(key) &&
    key.startsWith(owner + '/')
  );
}

// Internal maintenance primitive. No enumeration and no original-key deletion.
// A durable fence must precede R2 delete: HEAD alone cannot prevent publication races.
export async function cleanStorageCopy(
  db: D1Database,
  bucket: R2Bucket,
  identity: Identity,
  input: Record<string, unknown>,
) {
  for (const field of Object.keys(input))
    if (field !== 'key') invalid(field, '仅接受 key，请移除此字段');
  const key = input.key;
  if (typeof key !== 'string' || !isStorageCopyKey(key, identity.id))
    invalid('key', '仅可指定当前账号的摘要副本键；原图及未知对象不可清理');
  const live = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND s.user_id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)`;
  const args = [identity.session_id, identity.id, Date.now()];
  // The INSERT trigger atomically checks every reference, across owners. Reference
  // triggers then reject this key forever, including after completion/response loss.
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO r2_cleanup_claims(object_key,owner_id,status)
      SELECT ?,?,'claimed' WHERE ${live} ON CONFLICT(object_key) DO NOTHING`,
        )
        .bind(key, identity.id, ...args),
    ]);
  } catch (error) {
    if (String(error).includes('R2_REFERENCED'))
      throw new HttpError(409, 'key：对象仍有引用或预约，必须保留，不可清理', 'key');
    throw error;
  }
  const claim = await db
    .prepare(
      `SELECT status FROM r2_cleanup_claims
    WHERE object_key=? AND owner_id=? AND ${live}`,
    )
    .bind(key, identity.id, ...args)
    .first<{ status: string }>();
  if (!claim) throw new HttpError(409, 'key：清理认领或会话已改变，请重新登录后重试', 'key');
  // Delete is idempotent. Also repeat after done: a stale legacy PUT may have
  // recreated unreferenced bytes, but the permanent fence still forbids publication.
  await bucket.delete(key);
  if (await bucket.head(key))
    throw new HttpError(503, 'key：删除结果暂不可确认，请保留清理标记并用同一 key 重试', 'key');
  await db
    .prepare(`UPDATE r2_cleanup_claims SET status='done' WHERE object_key=? AND owner_id=?`)
    .bind(key, identity.id)
    .run();
  return { done: true, originalRetained: true };
}
