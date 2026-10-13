// Test-only entry point. Production builds still use src/index.ts.
import app from '../../src/index';

export default {
  async fetch(request: Request, env: Env) {
    const fault = request.headers.get('x-test-storage-fault');
    if (!fault) return app.fetch(request, env);
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
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (fault === 'after-d1') throw new Error('TEST_D1_RESPONSE_LOST');
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return app.fetch(clean, { ...env, IMMICH_CF_MEDIA: media, IMMICH_CF_DB: db });
  },
};
