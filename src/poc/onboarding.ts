import type { Identity } from './auth';
import { body, invalid } from './http';

interface Onboarding {
  is_onboarded: number;
  deleted: number;
  revision: number;
}

export async function onboarding(request: Request, db: D1Database, identity: Identity) {
  if (request.method === 'GET') {
    const row = await db
      .prepare('SELECT is_onboarded, deleted FROM user_onboarding WHERE user_id = ?')
      .bind(identity.id)
      .first<Onboarding>();
    return Response.json({ isOnboarded: !!row && !row.deleted && !!row.is_onboarded });
  }
  const deleted = request.method === 'DELETE';
  let value = false;
  if (!deleted) {
    const input = await body(request);
    if (typeof input.isOnboarded !== 'boolean') invalid('isOnboarded', '必须填写 true 或 false');
    value = input.isOnboarded;
  }
  // Atomic per-user revision: concurrent writes cannot share a cursor.
  await db
    .prepare(
      `INSERT INTO user_onboarding (user_id, is_onboarded, deleted, revision)
    VALUES (?, ?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET
    is_onboarded = excluded.is_onboarded, deleted = excluded.deleted, revision = revision + 1`,
    )
    .bind(identity.id, value ? 1 : 0, deleted ? 1 : 0)
    .run();
  return deleted ? new Response(null, { status: 204 }) : Response.json({ isOnboarded: value });
}

export async function onboardingEvents(db: D1Database, identity: Identity, reset = false) {
  const row = await db
    .prepare('SELECT is_onboarded, deleted, revision FROM user_onboarding WHERE user_id = ?')
    .bind(identity.id)
    .first<Onboarding>();
  if (!row) return [];
  const cursor = String(row.revision).padStart(20, '0');
  const checkpoints = await db
    .prepare(
      "SELECT ack FROM sync_checkpoints WHERE session_id = ? AND type IN ('UserMetadataV1', 'UserMetadataDeleteV1')",
    )
    .bind(identity.session_id)
    .all<{ ack: string }>();
  // Both families describe the same key: an acknowledged deletion must suppress an older value.
  if (!reset && checkpoints.results.some(({ ack }) => ack.split('|')[1]! >= cursor)) return [];
  const type = row.deleted ? 'UserMetadataDeleteV1' : 'UserMetadataV1';
  return [
    {
      type,
      ack: `${type}|${cursor}`,
      data: {
        userId: identity.id,
        key: 'onboarding',
        ...(row.deleted ? {} : { value: { isOnboarded: !!row.is_onboarded } }),
      },
    },
  ];
}
