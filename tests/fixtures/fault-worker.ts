// Test-only entry point. Production builds still use src/index.ts.
import app from '../../src/index';
import { authenticate } from '../../src/poc/auth';
import { retireAsset } from '../../src/poc/asset-history';
import { body, HttpError } from '../../src/poc/http';
import { runPurgeJobs } from '../../src/poc/purge';
import { storageInventory } from '../../src/poc/storage-inventory';
import { cleanStorageCopy } from '../../src/poc/storage-cleanup';
import { compactHistory } from '../../src/poc/history-cleanup';

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
    let bodyChunks = 0;
    let bodyCancelled = false;
    const gateId = request.headers.get('x-test-sync-gate');
    const fault = request.headers.get('x-test-storage-fault');
    const retirement = new URL(request.url).pathname.match(/^\/__test\/retire\/([a-f0-9-]{36})$/i);
    const purgeRun = new URL(request.url).pathname === '/__test/purge-run';
    const inventory = new URL(request.url).pathname === '/__test/storage-inventory';
    const storageCleanup = new URL(request.url).pathname === '/__test/storage-cleanup';
    const cleanup = new URL(request.url).pathname === '/__test/history-cleanup';
    if (
      !fault &&
      !gateId &&
      !countReads &&
      !retirement &&
      !cleanup &&
      !storageCleanup &&
      !inventory &&
      !purgeRun
    )
      return app.fetch(request, env);
    let clean = new Request(request);
    clean.headers.delete('x-test-storage-fault');
    if (fault === 'multipart-20mib' || fault === 'multipart-20mib-declared') {
      await clean.arrayBuffer();
      const prefix = new TextEncoder().encode(
        '--large\r\nContent-Disposition: form-data; name="assetData"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n',
      );
      const suffix = new TextEncoder().encode('\r\n--large--\r\n');
      const block = new Uint8Array(65536);
      let step = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          bodyChunks++;
          if (step === 0) controller.enqueue(prefix);
          else if (step <= 320) controller.enqueue(block);
          else if (step === 321) controller.enqueue(suffix);
          else controller.close();
          step++;
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      const headers = new Headers(clean.headers);
      headers.set('content-type', 'multipart/form-data; boundary=large');
      headers.delete('content-length');
      if (fault === 'multipart-20mib-declared')
        headers.set('content-length', String(prefix.length + 20 * 1024 * 1024 + suffix.length));
      clean = new Request(clean.url, { method: clean.method, headers, body: stream });
    }
    if (fault === 'multipart-byte-split' || fault === 'multipart-block-split') {
      // Inject the requested chunk boundaries after the real HTTP body was received.
      const bytes = new Uint8Array(await clean.arrayBuffer());
      const step = fault === 'multipart-byte-split' ? 1 : 17;
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          bodyChunks++;
          if (offset >= bytes.length) controller.close();
          else {
            controller.enqueue(bytes.subarray(offset, offset + step));
            offset += step;
          }
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      const headers = new Headers(clean.headers);
      headers.delete('content-length');
      clean = new Request(clean.url, { method: clean.method, headers, body: stream });
    }
    if (fault === 'upload-read' || fault === 'upload-cancel') {
      // Finish receiving the real HTTP request before replacing it with a synthetic stream.
      // Otherwise cancellation can abort workerd's proxy rather than test app recovery.
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
        if (key === 'list')
          return async (...args: Parameters<R2Bucket['list']>) => {
            if (fault === 'inventory-list') throw new Error('TEST_PRIVATE_LIST_ERROR');
            const result = await target.list(...args);
            if (fault === 'inventory-scope' && result.objects[0])
              result.objects[0].key = 'OTHER_ACCOUNT_PRIVATE_KEY';
            return result;
          };
        if (key === 'delete')
          return async (...args: Parameters<R2Bucket['delete']>) => {
            if (fault === 'gc-before-delete' || fault === 'purge-before-delete')
              throw new Error('TEST_GC_DELETE');
            await target.delete(...args);
            if (fault === 'purge-recreate')
              await target.put(args[0] as string, 'late synthetic bytes');
            if (fault === 'gc-after-delete' || fault === 'purge-after-delete')
              throw new Error('TEST_GC_RESPONSE_LOST');
          };
        if (key === 'get')
          return async (...args: Parameters<R2Bucket['get']>) => {
            if (fault === 'get-r2') throw new Error('TEST_R2_GET_UNAVAILABLE');
            if (fault === 'replace-before-get')
              await target.put(args[0], new Uint8Array([1, 2, 3]));
            if (fault === 'same-size-before-get') {
              const previous = await target.get(args[0]);
              const bytes = new Uint8Array(await previous!.arrayBuffer());
              bytes[0] = bytes[0]! ^ 1;
              await target.put(args[0], bytes, {
                sha1: await crypto.subtle.digest('SHA-1', bytes),
              });
            }
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
            if (fault === 'upgrade-target-race') {
              await target.put(args[0], new Uint8Array([9, 8, 7]));
            }
            if (fault === 'put-wrong-sha1') args[2] = { ...args[2], sha1: new Uint8Array(20) };
            if (fault === 'put-no-sha1') {
              const { sha1: ignored, ...rest } = args[2] ?? {};
              void ignored;
              args[2] = rest;
            }
            const result = await target.put(...args);
            if (fault === 'rollout-other-publisher') {
              const [owner] = args[0].split('/');
              const bytes = args[1] as Uint8Array;
              const checksum = btoa(
                String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))),
              );
              const id = crypto.randomUUID();
              const key = `${owner}/${id}/original`;
              await target.put(key, bytes, args[2]);
              await env.IMMICH_CF_DB.prepare(
                `INSERT INTO assets
                (id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite,r2_sha1_verified)
                VALUES (?,?,?,?,?,'image/png',?,320,240,?,?,?,0,1)`,
              )
                .bind(
                  id,
                  owner,
                  checksum,
                  key,
                  'other-publisher.png',
                  bytes.length,
                  '2026-10-17T00:00:00Z',
                  '2026-10-17T00:00:00Z',
                  '2026-10-17T00:00:00Z',
                )
                .run();
            }
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
            if (fault === 'purge-status-db' && sql.startsWith('UPDATE asset_purge_objects'))
              throw new Error('TEST_PURGE_STATUS_LOST');
            if (fault === 'purge-before-fence' && sql.startsWith('INSERT INTO asset_purge_fences'))
              throw new Error('TEST_PURGE_CLAIM_LOST');
            if (
              fault === 'inventory-db' &&
              (sql.startsWith('SELECT k.value object_key') ||
                sql.startsWith('SELECT /* inventory references */') ||
                sql.startsWith('SELECT object_key FROM r2_cleanup_claims'))
            )
              throw new Error('TEST_PRIVATE_INVENTORY_DB_ERROR');
            if (fault === 'gc-complete-db' && sql.startsWith('UPDATE r2_cleanup_claims'))
              throw new Error('TEST_GC_COMPLETE_UNAVAILABLE');
            if (
              fault === 'integrity-upgrade-db' &&
              sql.startsWith('UPDATE assets SET r2_sha1_verified')
            )
              throw new Error('TEST_INTEGRITY_UPGRADE_UNAVAILABLE');
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
    let response: Response;
    if (
      (retirement || cleanup || storageCleanup || inventory || purgeRun) &&
      clean.method === 'POST'
    ) {
      try {
        // Drain the bounded test JSON before early auth rejection. Otherwise
        // workerd's test ProxyWorker can poison the next multipart connection.
        let input: Record<string, unknown> = {};
        if (retirement) await clean.arrayBuffer();
        else input = await body(clean);
        const identity = await authenticate(clean, db);
        response = Response.json(
          purgeRun
            ? await runPurgeJobs(
                { ...env, IMMICH_CF_DB: db, IMMICH_CF_MEDIA: media },
                {
                  ownerId: identity.id,
                  assetIds: Array.isArray(input.ids) ? (input.ids as string[]) : undefined,
                },
              )
            : inventory
              ? await storageInventory(db, media, identity, input)
              : storageCleanup
                ? await cleanStorageCopy(db, media, identity, input)
                : cleanup
                  ? await compactHistory(db, identity, input)
                  : await retireAsset(db, identity, retirement![1]!),
        );
      } catch (error) {
        response = Response.json(
          {
            message: error instanceof HttpError ? error.message : 'Test maintenance failed',
            ...(error instanceof HttpError && error.field
              ? { errors: [{ path: [error.field], message: error.message }] }
              : {}),
          },
          { status: error instanceof HttpError ? error.status : 503 },
        );
      }
    } else response = await app.fetch(clean, { ...env, IMMICH_CF_MEDIA: media, IMMICH_CF_DB: db });
    if (storageCleanup && fault === 'gc-response-lost' && response.ok)
      return Response.json({ message: 'TEST_RESPONSE_LOST' }, { status: 503 });
    if (fault === 'upload-read' || fault === 'upload-cancel')
      response.headers.set('x-test-body-locked', String(clean.body?.locked));
    if (fault?.startsWith('multipart-')) {
      response.headers.set('x-test-body-locked', String(clean.body?.locked));
      response.headers.set('x-test-body-chunks', String(bodyChunks));
      response.headers.set('x-test-body-cancelled', String(bodyCancelled));
    }
    if (countReads) response.headers.set('x-test-checkpoint-reads', String(checkpointReads));
    if (countReads) response.headers.set('x-test-delivery-writes', String(deliveryWrites));
    if (countReads) response.headers.set('x-test-media-heads', String(mediaHeads));
    return response;
  },
};
