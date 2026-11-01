import app from '../../src/index';
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === '/__test/origin')
      return new Response(new URL(request.url).origin);
    const mode = request.headers.get('x-test-images');
    const db = env.IMMICH_CF_DB;
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
