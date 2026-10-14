import type { Identity } from './auth';
import { body, HttpError, invalid, strings, uuid7 } from './http';
import { entityTypes, supportedTypes } from './types';
import { onboardingEvents } from './onboarding';
import { assetEvents } from './assets';
import { syncLines as lines } from './sync-lines';

interface SyncState {
  sync_epoch: string;
  reset_pending: number;
  reset_ack: string | null;
}
async function guarded(
  db: D1Database,
  session: string,
  epoch: string,
  operation: string,
  statements: D1PreparedStatement[],
  acks: string[] = [],
) {
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare('INSERT INTO sync_guards VALUES (?,?,?,?,?,?)')
        .bind(id, session, epoch, operation, JSON.stringify(acks), Date.now()),
      ...statements,
      db.prepare('DELETE FROM sync_guards WHERE id=?').bind(id),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('SYNC_ACK_INVALID'))
      invalid('acks', '确认记录已失效或不属于当前同步轮次，请重新拉取同步流');
    if (error instanceof Error && error.message.includes('SYNC_STALE'))
      throw new HttpError(409, '同步状态已改变，请重新拉取同步流后重试');
    throw new HttpError(503, '同步状态暂不可确认，请重试；重置确认请重发原 ACK');
  }
}

export async function sync(
  request: Request,
  db: D1Database,
  identity: Identity,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const session = identity.session_id;
  if (path === '/api/sync/ack' && request.method === 'GET') {
    const rows = await db
      .prepare('SELECT type, ack FROM sync_checkpoints WHERE session_id = ? ORDER BY type')
      .bind(session)
      .all();
    return Response.json(rows.results);
  }
  const input = await body(request);
  const state = await db
    .prepare('SELECT sync_epoch,reset_pending,reset_ack FROM sessions WHERE id=?')
    .bind(session)
    .first<SyncState>();
  if (!state) throw new HttpError(401, '会话已失效，请重新登录');
  const epoch = state.sync_epoch;
  if (path === '/api/sync/ack' && request.method === 'DELETE') {
    const types = input.types === undefined ? undefined : strings(input, 'types', entityTypes);
    if (!types || types.length) {
      const clause = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
      await guarded(db, session, epoch, 'clear', [
        db
          .prepare(`DELETE FROM sync_checkpoints WHERE session_id=?${clause}`)
          .bind(session, ...(types ?? [])),
        db.prepare('DELETE FROM sync_deliveries WHERE session_id=?').bind(session),
        db
          .prepare('UPDATE sessions SET sync_epoch=?,last_reset_ack=NULL,updated_at=? WHERE id=?')
          .bind(crypto.randomUUID(), Date.now(), session),
      ]);
    }
    return new Response(null, { status: 204 });
  }
  if (path === '/api/sync/ack' && request.method === 'POST') {
    const acks = strings(input, 'acks');
    if (acks.length === 0) return new Response(null, { status: 204 });
    if (acks.some((ack) => ack.startsWith('SyncResetV1|'))) {
      if (acks.length !== 1) invalid('acks', '重置确认必须单独提交，请只发送本次 reset 的 ACK');
      // A lost success response may be retried without clearing newly rebuilt checkpoints.
      await guarded(
        db,
        session,
        epoch,
        'reset-ack',
        [
          ...['sync_checkpoints', 'sync_deliveries'].map((table) =>
            db
              .prepare(
                `DELETE FROM ${table} WHERE session_id=? AND EXISTS
            (SELECT 1 FROM sessions WHERE id=? AND reset_pending=1)`,
              )
              .bind(session, session),
          ),
          db
            .prepare(
              `UPDATE sessions SET reset_pending=0,last_reset_ack=reset_ack,
          reset_ack=NULL,updated_at=? WHERE id=? AND reset_pending=1`,
            )
            .bind(Date.now(), session),
        ],
        acks,
      );
      return new Response(null, { status: 204 });
    }
    await guarded(
      db,
      session,
      epoch,
      'ack',
      acks.map((ack) =>
        db
          .prepare(
            'INSERT INTO sync_checkpoints (session_id,type,ack) VALUES (?,?,?) ON CONFLICT(session_id,type) DO UPDATE SET ack=excluded.ack WHERE excluded.ack>sync_checkpoints.ack',
          )
          .bind(session, ack.split('|')[0], ack),
      ),
      acks,
    );
    return new Response(null, { status: 204 });
  }
  const types = strings(input, 'types', supportedTypes);
  if (input.reset !== undefined && typeof input.reset !== 'boolean')
    invalid('reset', '必须为 true 或 false');
  const complete = await db
    .prepare("SELECT ack FROM sync_checkpoints WHERE session_id = ? AND type = 'SyncCompleteV1'")
    .bind(session)
    .first<{ ack: string }>();
  const completeTime = complete
    ? Number.parseInt(complete.ack.split('|')[1]!.replaceAll('-', '').slice(0, 12), 16)
    : Date.now();
  if (state.reset_pending) {
    await guarded(db, session, epoch, 'pending', []);
    return lines([{ type: 'SyncResetV1', data: {}, ack: state.reset_ack! }]);
  }
  if (input.reset || Date.now() - completeTime > 30 * 86400000) {
    const next = crypto.randomUUID();
    const ack = `SyncResetV1|reset|${next}`;
    await guarded(db, session, epoch, 'reset', [
      db
        .prepare(
          `UPDATE sessions SET sync_epoch=?,reset_pending=1,reset_ack=?,
        last_reset_ack=NULL,updated_at=? WHERE id=?`,
        )
        .bind(next, ack, Date.now(), session),
      db.prepare('DELETE FROM sync_deliveries WHERE session_id=?').bind(session),
    ]);
    return lines([{ type: 'SyncResetV1', data: {}, ack }]);
  }
  const events: { type: string; data: unknown; ack: string }[] = [];
  if (types.includes('AuthUsersV2')) {
    const ack = `AuthUserV2|${identity.update_id}:${String(identity.asset_revision ?? 0).padStart(20, '0')}`;
    const prior = await db
      .prepare("SELECT ack FROM sync_checkpoints WHERE session_id = ? AND type = 'AuthUserV2'")
      .bind(session)
      .first<{ ack: string }>();
    if (!prior || prior.ack < ack)
      events.push({
        type: 'AuthUserV2',
        ack,
        data: {
          id: identity.id,
          email: identity.email,
          name: identity.name,
          isAdmin: false,
          deletedAt: null,
          hasProfileImage: false,
          oauthId: null,
          pinCode: null,
          profileChangedAt: identity.created_at,
          quotaSizeInBytes: null,
          quotaUsageInBytes: identity.quota_usage ?? 0,
          storageLabel: null,
          avatarColor: 'primary',
        },
      });
  }
  // AuthUserV2 populates auth_user_entity only. Asset owner_id references user_entity,
  // so the separate UserV1 must be applied before any owned asset arrives.
  if (types.includes('UsersV1')) {
    const ack = `UserV1|${identity.update_id}`;
    const prior = await db
      .prepare("SELECT ack FROM sync_checkpoints WHERE session_id = ? AND type = 'UserV1'")
      .bind(session)
      .first<{ ack: string }>();
    if (!prior || prior.ack < ack)
      events.push({
        type: 'UserV1',
        ack,
        data: {
          id: identity.id,
          email: identity.email,
          name: identity.name,
          deletedAt: null,
          hasProfileImage: false,
          profileChangedAt: identity.created_at,
          avatarColor: 'primary',
        },
      });
  }
  if (types.includes('UserMetadataV1')) events.push(...(await onboardingEvents(db, identity)));
  events.push(...(await assetEvents(db, identity, types)));
  events.push({ type: 'SyncCompleteV1', data: {}, ack: `SyncCompleteV1|${uuid7()}` });
  // Cursor comparisons above use the unchanged cursor prefix; wire ACKs bind to a generation.
  if (epoch) for (const event of events) event.ack += `|${epoch}`;
  await guarded(db, session, epoch, 'stream', [
    db
      .prepare('DELETE FROM sync_deliveries WHERE session_id = ? AND issued_at < ?')
      .bind(session, Date.now() - 86400000),
    ...events.map((event) =>
      db
        .prepare(
          'INSERT INTO sync_deliveries (session_id,type,ack,issued_at) VALUES (?,?,?,?) ON CONFLICT(session_id,ack) DO UPDATE SET issued_at=excluded.issued_at',
        )
        .bind(session, event.type, event.ack, Date.now()),
    ),
  ]);
  return lines(events);
}
