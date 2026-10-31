import app from '../../src/index';
import { runPreviews } from '../../src/poc/previews';
import { inspectMedia } from '../../src/poc/media-format';
import { cleanStaging } from '../../src/poc/media-staging';
export default {
  async fetch(request: Request, env: Env) {
    // The dev proxy cannot forward a malformed multipart after an upstream cancel.
    // As in fault-worker.ts, inject the actual parser stream behind that proxy.
    if (request.headers.has('x-test-multipart-split')) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      let at = 0;
      request = new Request(request, {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (at >= bytes.length) {
              controller.close();
              return;
            }
            const next = Math.min(at + 17, bytes.length);
            controller.enqueue(bytes.subarray(at, next));
            at = next;
          },
        }),
      });
    }
    const mode = request.headers.get('x-test-images');
    const configured = {
      ...env,
      ENABLE_LIVE_PHOTO: 'true',
      IMAGES_FREE_CONFIRMED: mode === 'unconfirmed' ? 'false' : 'true',
      IMAGES: {
        input() {
          return {
            transform() {
              return this;
            },
            async output() {
              if (mode === 'quota') throw new Error('9422');
              if (mode === 'failure') throw new Error('TEST_IMAGES_DOWN');
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
    } as unknown as Env;
    if (new URL(request.url).pathname === '/__test/previews')
      return Response.json(
        await runPreviews(configured, new URL(request.url).searchParams.get('id') ?? undefined),
      );
    if (new URL(request.url).pathname === '/__test/inspect') {
      const key = new URL(request.url).searchParams.get('key')!;
      const info = await inspectMedia(
        env.IMMICH_CF_MEDIA,
        key,
        (await env.IMMICH_CF_MEDIA.head(key))!.size,
      );
      return Response.json({ ...info, pair: !!info.pair });
    }
    if (new URL(request.url).pathname === '/__test/clean-staging') {
      await cleanStaging(env);
      return Response.json({ ok: true });
    }
    return app.fetch(request, configured);
  },
};
