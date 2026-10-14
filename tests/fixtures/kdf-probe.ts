// Local-only synthetic KDF experiment. Never imported by src/index.ts.
import { scryptSync } from 'node:crypto';
export default {
  async fetch(request: Request) {
    const algorithm = new URL(request.url).pathname.slice(1);
    const password = new TextEncoder().encode('immich-cf-synthetic-kdf-fixture');
    const salt = new TextEncoder().encode('immich-cf-kdf-salt-16');
    try {
      let result: ArrayBuffer | Uint8Array;
      if (algorithm === 'pbkdf2-sha256-600000') {
        const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
        result = await crypto.subtle.deriveBits(
          { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 },
          key,
          256,
        );
      } else if (algorithm === 'scrypt-n32768-r8-p3') {
        result = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
      } else return new Response(null, { status: 404 });
      return Response.json({
        supported: true,
        hex: Array.from(new Uint8Array(result), (x) => x.toString(16).padStart(2, '0')).join(''),
      });
    } catch (error) {
      return Response.json({
        supported: false,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  },
};
