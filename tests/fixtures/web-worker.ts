import app from '../../src/index';
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === '/__test/origin')
      return new Response(new URL(request.url).origin);
    const mode = request.headers.get('x-test-images');
    const db = env.IMMICH_CF_DB;
    let photoBatches = 0;
    const configured = {
      ...env,
      IMAGES_FREE_CONFIRMED: 'true',
      IMAGES: {
        input() {
          return {
            transform() {
              return this;
            },
            async output() {
              if (mode === 'quota') throw new Error('9422');
              if (mode === 'failure') throw new Error('TEST_PREVIEW_FAILED');
              return {
                response() {
                  return new Response(new Uint8Array([255, 216, 255, 217]), {
                    headers: { 'Content-Type': 'image/jpeg' },
                  });
                },
              };
            },
          };
        },
      },
      IMMICH_CF_DB: request.headers.has('x-test-revoke-operator')
        ? {
            prepare: db.prepare.bind(db),
            async batch(statements: D1PreparedStatement[]) {
              await db.prepare('DELETE FROM operations_admins').run();
              return db.batch(statements);
            },
          }
        : request.headers.has('x-test-gps-commit')
          ? {
              prepare: db.prepare.bind(db),
              async batch(statements: D1PreparedStatement[]) {
                if (++photoBatches === 4) {
                  const action = request.headers.get('x-test-gps-commit');
                  if (action === 'revoke')
                    await db
                      .prepare('DELETE FROM sessions WHERE id=?')
                      .bind(request.headers.get('x-test-gps-session'))
                      .run();
                  if (action === 'edit')
                    await db
                      .prepare('UPDATE assets SET photo_metadata=?,file_created_at=? WHERE id=?')
                      .bind(
                        JSON.stringify({
                          extracted: false,
                          source: {},
                          overrides: {
                            latitude: null,
                            longitude: null,
                            description: '并发手动说明',
                          },
                          timeSource: 'manual',
                          timeZone: 'UTC',
                        }),
                        '2010-01-02T03:04:05.000Z',
                        request.headers.get('x-test-gps-asset'),
                      )
                      .run();
                  if (action === 'pause')
                    await db
                      .prepare("UPDATE web_gps_jobs SET state='paused' WHERE id=?")
                      .bind(request.headers.get('x-test-gps-job'))
                      .run();
                  if (action === 'cancel')
                    await db
                      .prepare(
                        "UPDATE web_gps_jobs SET state='cancelled',lease=NULL,lease_until=0 WHERE id=?",
                      )
                      .bind(request.headers.get('x-test-gps-job'))
                      .run();
                  if (action === 'expire')
                    await db
                      .prepare('UPDATE web_gps_jobs SET lease_until=0 WHERE id=?')
                      .bind(request.headers.get('x-test-gps-job'))
                      .run();
                  if (action === 'rollback')
                    return db.batch([
                      ...statements,
                      db.prepare('INSERT INTO gps_test_rollback VALUES(1)'),
                    ]);
                }
                return db.batch(statements);
              },
            }
          : request.headers.has('x-test-revoke-photo-session')
            ? {
                prepare: db.prepare.bind(db),
                async batch(statements: D1PreparedStatement[]) {
                  if (++photoBatches === 2)
                    await db
                      .prepare('DELETE FROM sessions WHERE id=?')
                      .bind(request.headers.get('x-test-revoke-photo-session'))
                      .run();
                  return db.batch(statements);
                },
              }
            : request.headers.has('x-test-label-commit')
              ? {
                  prepare: db.prepare.bind(db),
                  async batch(statements: D1PreparedStatement[]) {
                    if (++photoBatches === 2) {
                      const action = request.headers.get('x-test-label-commit'),
                        session = request.headers.get('x-test-transfer-session');
                      if (action === 'revoke')
                        await db.prepare('DELETE FROM sessions WHERE id=?').bind(session).run();
                      if (action === 'expire')
                        await db
                          .prepare('UPDATE sessions SET expires_at=0 WHERE id=?')
                          .bind(session)
                          .run();
                      if (action === 'disable')
                        await db
                          .prepare(
                            'UPDATE users SET disabled=1 WHERE id=(SELECT user_id FROM sessions WHERE id=?)',
                          )
                          .bind(session)
                          .run();
                      if (action === 'stale')
                        await db
                          .prepare(
                            "UPDATE albums SET description=description||' concurrent' WHERE id=?",
                          )
                          .bind(request.headers.get('x-test-transfer-target'))
                          .run();
                    }
                    return db.batch(statements);
                  },
                }
              : request.headers.has('x-test-album-transfer')
                ? {
                    prepare: db.prepare.bind(db),
                    async batch(statements: D1PreparedStatement[]) {
                      const action = request.headers.get('x-test-album-transfer');
                      const session = request.headers.get('x-test-transfer-session');
                      if (action === 'revoke')
                        await db.prepare('DELETE FROM sessions WHERE id=?').bind(session).run();
                      if (action === 'expire')
                        await db
                          .prepare('UPDATE sessions SET expires_at=0 WHERE id=?')
                          .bind(session)
                          .run();
                      if (action === 'disable')
                        await db
                          .prepare(
                            'UPDATE users SET disabled=1 WHERE id=(SELECT user_id FROM sessions WHERE id=?)',
                          )
                          .bind(session)
                          .run();
                      if (action === 'target-delete')
                        await db
                          .prepare('DELETE FROM albums WHERE id=?')
                          .bind(request.headers.get('x-test-transfer-target'))
                          .run();
                      if (action === 'stale')
                        await db
                          .prepare(
                            "UPDATE albums SET description=description||' concurrent' WHERE id=?",
                          )
                          .bind(request.headers.get('x-test-transfer-target'))
                          .run();
                      return db.batch(statements);
                    },
                  }
                : db,
    } as unknown as Env;
    // Synchronous preview mode makes transformation failure and quota states deterministic.
    return app.fetch(
      request,
      configured,
      request.headers.has('x-test-sync-preview') ? undefined : ctx,
    );
  },
};
