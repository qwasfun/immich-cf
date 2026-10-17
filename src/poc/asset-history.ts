import type { Identity } from './auth';
import { HttpError, invalid } from './http';

// Internal business primitive; no public delete API or R2 deletion is enabled.
export async function retireAsset(db: D1Database, identity: Identity, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) invalid('id', '请提供有效资产 ID');
  const liveSession = `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND s.user_id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)`;
  const [result] = await db.batch([
    db
      .prepare(`DELETE FROM assets WHERE id=? AND owner_id=? AND ${liveSession}`)
      .bind(id, identity.id, identity.session_id, identity.id, Date.now()),
  ]);
  if (result!.meta.changes) return { id, applied: true };
  const prior = await db
    .prepare(`SELECT id FROM retired_assets WHERE id=? AND owner_id=? AND ${liveSession}`)
    .bind(id, identity.id, identity.session_id, identity.id, Date.now())
    .first();
  if (prior) return { id, applied: false };
  throw new HttpError(404, '资产不存在或当前会话无权操作');
}
