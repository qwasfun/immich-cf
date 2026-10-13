import type { Identity } from './auth';
import { HttpError, invalid } from './http';

export async function sessions(request: Request, db: D1Database, identity: Identity) {
  const path = new URL(request.url).pathname;
  if (path === '/api/sessions' && request.method === 'GET') {
    const rows = await db
      .prepare(
        'SELECT id, expires_at, created_at, updated_at, reset_pending FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at, id',
      )
      .bind(identity.id, Date.now())
      .all<{
        id: string;
        expires_at: number;
        created_at: number;
        updated_at: number;
        reset_pending: number;
      }>();
    return Response.json(
      rows.results.map((row) => ({
        id: row.id,
        current: row.id === identity.session_id,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
        // Device identification is not yet collected; do not infer a device from arbitrary headers.
        deviceOS: '',
        deviceType: '',
        appVersion: null,
        isPendingSyncReset: !!row.reset_pending,
      })),
    );
  }
  if (path === '/api/sessions') {
    await db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
      .bind(identity.id, identity.session_id)
      .run();
  } else {
    const id = path.slice('/api/sessions/'.length);
    if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id))
      invalid('id', '会话 ID 必须是有效的 UUID v4');
    // Ownership is checked in the same mutation; a foreign ID can never revoke a session.
    const result = await db
      .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
      .bind(id, identity.id)
      .run();
    if (!result.meta.changes) throw new HttpError(400, '会话不存在或无权访问，请刷新会话列表');
  }
  return new Response(null, { status: 204 });
}
