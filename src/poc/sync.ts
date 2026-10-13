import type { Identity } from './auth';
import { body, HttpError, invalid, strings, uuid7 } from './http';
import { entityTypes, supportedTypes } from './types';
import { onboardingEvents } from './onboarding';
import { assetEvents } from './assets';

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
  if (path === '/api/sync/ack' && request.method === 'DELETE') {
    const types = input.types === undefined ? undefined : strings(input, 'types', entityTypes);
    if (!types || types.length) {
      const clause = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
      await db.batch(
        ['sync_checkpoints', 'sync_deliveries'].map((table) =>
          db
            .prepare(`DELETE FROM ${table} WHERE session_id = ?${clause}`)
            .bind(session, ...(types ?? [])),
        ),
      );
    }
    return new Response(null, { status: 204 });
  }
  if (path === '/api/sync/ack' && request.method === 'POST') {
    const acks = strings(input, 'acks');
    if (acks.length === 0) return new Response(null, { status: 204 });
    if (acks.includes('SyncResetV1|reset')) {
      if (!identity.reset_pending || acks.length !== 1)
        invalid('acks', '重置确认必须单独提交，且当前会话必须处于待重置状态');
      await db.batch([
        db.prepare('DELETE FROM sync_checkpoints WHERE session_id = ?').bind(session),
        db.prepare('DELETE FROM sync_deliveries WHERE session_id = ?').bind(session),
        db
          .prepare('UPDATE sessions SET reset_pending = 0, updated_at = ? WHERE id = ?')
          .bind(Date.now(), session),
      ]);
      return new Response(null, { status: 204 });
    }
    if (identity.reset_pending) throw new HttpError(409, '同步状态待重置，请先确认 reset');
    // 空库 PoC 只接受当前会话实际发出的 ACK。验证全部输入后才写入，防止部分成功。
    const checkpoints = await db
      .prepare('SELECT ack FROM sync_checkpoints WHERE session_id = ?')
      .bind(session)
      .all<{ ack: string }>();
    const delivered = await db
      .prepare('SELECT ack FROM sync_deliveries WHERE session_id = ?')
      .bind(session)
      .all<{ ack: string }>();
    const allowed = new Set([...checkpoints.results, ...delivered.results].map((v) => v.ack));
    if (acks.some((ack) => !allowed.has(ack)))
      invalid('acks', '只能确认当前会话已收到的同步记录，请重新拉取同步流');
    await db.batch(
      acks.map((ack) =>
        db
          .prepare(
            'INSERT INTO sync_checkpoints (session_id, type, ack) VALUES (?, ?, ?) ON CONFLICT(session_id, type) DO UPDATE SET ack = excluded.ack WHERE excluded.ack > sync_checkpoints.ack',
          )
          .bind(session, ack.split('|')[0], ack),
      ),
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
  if (input.reset || identity.reset_pending || Date.now() - completeTime > 30 * 86400000) {
    await db
      .prepare('UPDATE sessions SET reset_pending = 1, updated_at = ? WHERE id = ?')
      .bind(Date.now(), session)
      .run();
    return lines([{ type: 'SyncResetV1', data: {}, ack: 'SyncResetV1|reset' }]);
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
  if (types.includes('UserMetadataV1')) events.push(...(await onboardingEvents(db, identity)));
  events.push(...(await assetEvents(db, identity, types)));
  events.push({ type: 'SyncCompleteV1', data: {}, ack: `SyncCompleteV1|${uuid7()}` });
  // 有限空库流在发出之前持久化可确认记录；不支持资产写入或关系 backfill。
  await db.batch([
    db
      .prepare('DELETE FROM sync_deliveries WHERE session_id = ? AND issued_at < ?')
      .bind(session, Date.now() - 86400000),
    ...events.map((event) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO sync_deliveries (session_id, type, ack, issued_at) VALUES (?, ?, ?, ?)',
        )
        .bind(session, event.type, event.ack, Date.now()),
    ),
  ]);
  return lines(events);
}

function lines(events: { type: string; data: unknown; ack: string }[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/jsonlines+json' } },
  );
}
