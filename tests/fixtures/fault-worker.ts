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
    const gateId = request.headers.get('x-test-sync-gate');
    const fault = request.headers.get('x-test-storage-fault');
    if (!fault && !gateId && !countReads) return app.fetch(request, env);
    const clean = new Request(request);
    clean.headers.delete('x-test-storage-fault');
    const media = new Proxy(env.IMMICH_CF_MEDIA, {
      get(target, key) {
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
    if (countReads) response.headers.set('x-test-checkpoint-reads', String(checkpointReads));
    if (countReads) response.headers.set('x-test-delivery-writes', String(deliveryWrites));
    return response;
  },
};
