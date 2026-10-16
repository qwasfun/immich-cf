// Test-only entry point. Production builds still use src/index.ts.
import app from '../../src/index';

const gates = new Map<string, { released: boolean }>();

export default {
  async fetch(request: Request, env: Env) {
    const gatePath = new URL(request.url).pathname.match(/^\/__test\/gates\/([a-z0-9-]+)$/);
    if (gatePath) {
      const gate = gates.get(gatePath[1]!);
      if (request.method === 'POST') {
        if (gate) gate.released = true;
        gates.delete(gatePath[1]!);
      }
      return Response.json({ waiting: !!gate });
    }
    const countReads = request.headers.has('x-test-count-checkpoints');
    let checkpointReads = 0;
    let deliveryWrites = 0;
    let mediaHeads = 0;
    const gateId = request.headers.get('x-test-sync-gate');
    const fault = request.headers.get('x-test-storage-fault');
    if (!fault && !gateId && !countReads) return app.fetch(request, env);
    let clean = new Request(request);
    clean.headers.delete('x-test-storage-fault');
    if (fault === 'upload-read' || fault === 'upload-cancel') {
      // Drain the real HTTP body before injecting a synthetic stream. Otherwise workerd's
      // proxy can abort the connection when the injected oversized stream is cancelled.
      await clean.arrayBuffer();
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            if (fault === 'upload-cancel') return;
            controller.error(new Error('TEST_UPLOAD_PRIVATE_ERROR'));
            return;
          }
          sent = true;
          controller.enqueue(
            new Uint8Array(fault === 'upload-cancel' ? 4 * 1024 * 1024 + 65537 : 8),
          );
        },
      });
      const headers = new Headers(clean.headers);
      headers.delete('content-length');
      clean = new Request(clean.url, { method: clean.method, headers, body: stream });
      if (fault === 'upload-cancel') {
        // Reject the reader operation without poisoning workerd's HTTP transport stream.
        const body = new Proxy(clean.body!, {
          get(target, key) {
            if (key === 'getReader')
              return () => {
                const reader = target.getReader();
                return new Proxy(reader, {
                  get(target, key) {
                    if (key === 'cancel')
                      return async () => {
                        await target.cancel();
                        throw new Error('TEST_CANCEL_PRIVATE_ERROR');
                      };
                    const value = Reflect.get(target, key, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                  },
                });
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        clean = new Proxy(clean, {
          get(target, key) {
            if (key === 'body') return body;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
    }
    const media = new Proxy(env.IMMICH_CF_MEDIA, {
      get(target, key) {
        if (key === 'get')
          return async (...args: Parameters<R2Bucket['get']>) => {
            if (fault === 'get-r2') throw new Error('TEST_R2_GET_UNAVAILABLE');
            if (fault === 'replace-before-get')
              await target.put(args[0], new Uint8Array([1, 2, 3]));
            if (fault === 'delete-before-get') await target.delete(args[0]);
            return target.get(...args);
          };
        if (key === 'head')
          return async (...args: Parameters<R2Bucket['head']>) => {
            mediaHeads++;
            if (fault === 'head-r2') throw new Error('TEST_R2_HEAD_UNAVAILABLE');
            return target.head(...args);
          };
        if (key === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            if (fault === 'before-r2') throw new Error('TEST_R2_UNAVAILABLE');
            const result = await target.put(...args);
            if (fault === 'after-r2') throw new Error('TEST_R2_RESPONSE_LOST');
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const db = new Proxy(env.IMMICH_CF_DB, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            if (fault === 'live-photo-db' && sql.includes('live_photo_blocks'))
              throw new Error('TEST_LIVE_PHOTO_DB_UNAVAILABLE');
            if (/SELECT.*FROM sync_checkpoints/i.test(sql)) checkpointReads++;
            if (/INSERT INTO sync_deliveries/i.test(sql)) deliveryWrites++;
            return target.prepare(sql);
          };
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (gateId) {
              const gate = { released: false };
              gates.set(gateId, gate);
              const deadline = Date.now() + 10000;
              while (!gate.released && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 10));
              if (!gate.released) throw new Error('TEST_GATE_TIMEOUT');
            }
            const result = await target.batch(statements);
            if (fault === 'after-d1') throw new Error('TEST_D1_RESPONSE_LOST');
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await app.fetch(clean, { ...env, IMMICH_CF_MEDIA: media, IMMICH_CF_DB: db });
    if (fault === 'upload-read' || fault === 'upload-cancel')
      response.headers.set('x-test-body-locked', String(clean.body?.locked));
    if (countReads) response.headers.set('x-test-checkpoint-reads', String(checkpointReads));
    if (countReads) response.headers.set('x-test-delivery-writes', String(deliveryWrites));
    if (countReads) response.headers.set('x-test-media-heads', String(mediaHeads));
    return response;
  },
};
