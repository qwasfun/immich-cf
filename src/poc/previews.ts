import { digest, HttpError } from './http';
import { media } from './media';
import { originalMatches } from './integrity';

export async function queuePreviews(env: Env, id: string) {
  const row = await env.IMMICH_CF_DB.prepare(
    "SELECT owner_id,checksum FROM assets WHERE id=? AND mime IN ('image/jpeg','image/png','image/heic') AND media_type='IMAGE'",
  )
    .bind(id)
    .first<{ owner_id: string; checksum: string }>();
  if (!row) return;
  const hash = await digest(row.checksum);
  await env.IMMICH_CF_DB.batch(
    [256, 2048].map((variant) =>
      env.IMMICH_CF_DB.prepare(
        `INSERT INTO media_previews(asset_id,owner_id,variant,object_key,source_checksum) VALUES(?,?,?,?,?) ON CONFLICT(asset_id,variant) DO NOTHING`,
      ).bind(
        id,
        row.owner_id,
        variant,
        `${row.owner_id}/${id}/preview/v1-${hash}-${variant}.jpg`,
        row.checksum,
      ),
    ),
  );
}
const nextMonth = () => {
  const date = new Date();
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) + 300000;
};
interface Preview {
  asset_id: string;
  owner_id: string;
  variant: number;
  object_key: string;
  source_checksum: string;
  bytes: number;
  checksum: string;
  status: string;
  lease_id: string;
}
export async function runPreviews(env: Env, assetId?: string) {
  if (String(env.IMAGES_FREE_CONFIRMED) !== 'true' || !env.IMAGES)
    return { processed: 0, reason: 'free-plan-unconfirmed' };
  const db = env.IMMICH_CF_DB,
    now = Date.now();
  const rows = await db
    .prepare(
      `SELECT * FROM media_previews WHERE status IN ('pending','failed','quota','processing') AND next_try_ms<=? AND lease_until_ms<=? ${assetId ? 'AND asset_id=?' : ''} ORDER BY next_try_ms,asset_id,variant LIMIT 2`,
    )
    .bind(now, now, ...(assetId ? [assetId] : []))
    .all<Preview>();
  let processed = 0;
  for (const row of rows.results) {
    const lease = crypto.randomUUID();
    const claim = await db
      .prepare(
        "UPDATE media_previews SET status='processing',lease_id=?,lease_until_ms=? WHERE asset_id=? AND variant=? AND lease_until_ms<=? AND status NOT IN ('ready','retired')",
      )
      .bind(lease, now + 120000, row.asset_id, row.variant, now)
      .run();
    if (!claim.meta.changes) continue;
    try {
      const asset = await db
        .prepare(
          "SELECT object_key,bytes,checksum,r2_sha1_verified FROM assets WHERE id=? AND owner_id=? AND mime IN ('image/jpeg','image/png','image/heic') AND checksum=?",
        )
        .bind(row.asset_id, row.owner_id, row.source_checksum)
        .first<{ object_key: string; bytes: number; checksum: string; r2_sha1_verified: number }>();
      if (!asset) {
        await db
          .prepare(
            "UPDATE media_previews SET status='retired',lease_id=NULL,lease_until_ms=0 WHERE asset_id=? AND variant=? AND lease_id=?",
          )
          .bind(row.asset_id, row.variant, lease)
          .run();
        continue;
      }
      const month = new Date().toISOString().slice(0, 7),
        budget = await db
          .prepare('SELECT blocked_until_ms FROM image_transform_budget WHERE month=?')
          .bind(month)
          .first<{ blocked_until_ms: number }>();
      if (budget && budget.blocked_until_ms > now) throw new HttpError(503, '9422');
      const usage = await db
        .prepare(
          `INSERT INTO image_transform_usage(month,transform_key) SELECT ?,? WHERE (SELECT COUNT(*) FROM image_transform_usage WHERE month=?)<5000 ON CONFLICT(month,transform_key) DO NOTHING`,
        )
        .bind(month, `${row.source_checksum}:${row.variant}:v1`, month)
        .run();
      if (
        !usage.meta.changes &&
        !(await db
          .prepare('SELECT 1 FROM image_transform_usage WHERE month=? AND transform_key=?')
          .bind(month, `${row.source_checksum}:${row.variant}:v1`)
          .first())
      )
        throw new HttpError(503, '9422');
      const source = await env.IMMICH_CF_MEDIA.get(asset.object_key);
      if (
        !source ||
        !originalMatches(source, asset.bytes, asset.checksum, !!asset.r2_sha1_verified)
      )
        throw new HttpError(503, 'ORIGINAL_UNAVAILABLE');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const transform = env.IMAGES.input(source.body)
        .transform({ width: row.variant, height: row.variant, fit: 'scale-down' })
        .output({ format: 'image/jpeg', quality: row.variant === 256 ? 80 : 85 });
      const result = await Promise.race([
        transform,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PREVIEW_TIMEOUT')), 45000);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      const response = result.response();
      if (!response.ok || !response.body) throw new Error('PREVIEW_UNAVAILABLE');
      // Derivatives are bounded independently from the original. No private originals are exposed by URL.
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 8 * 1024 * 1024) throw new Error('PREVIEW_TOO_LARGE');
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
        throw new Error('PREVIEW_INVALID');
      const sha1 = await crypto.subtle.digest('SHA-1', bytes),
        checksum = btoa(String.fromCharCode(...new Uint8Array(sha1)));
      const current = await db
        .prepare(
          "SELECT 1 FROM media_previews p JOIN assets a ON a.id=p.asset_id WHERE p.asset_id=? AND p.variant=? AND p.lease_id=? AND p.status='processing' AND p.lease_until_ms>? AND a.checksum=p.source_checksum",
        )
        .bind(row.asset_id, row.variant, lease, Date.now())
        .first();
      if (!current) continue;
      const saved = await env.IMMICH_CF_MEDIA.put(row.object_key, bytes, {
        sha1,
        httpMetadata: { contentType: 'image/jpeg' },
      });
      if (!originalMatches(saved, size, checksum, true)) throw new Error('PREVIEW_INTEGRITY');
      await db
        .prepare(
          "UPDATE media_previews SET status='ready',bytes=?,checksum=?,last_error=NULL,lease_until_ms=0,lease_id=NULL WHERE asset_id=? AND variant=? AND lease_id=? AND status='processing' AND EXISTS(SELECT 1 FROM assets WHERE id=asset_id AND checksum=source_checksum)",
        )
        .bind(size, checksum, row.asset_id, row.variant, lease)
        .run();
      processed++;
    } catch (error) {
      const quota = String(error).includes('9422'),
        next = quota ? nextMonth() : Date.now() + 300000;
      if (quota)
        await db
          .prepare(
            'INSERT INTO image_transform_budget(month,blocked_until_ms) VALUES(?,?) ON CONFLICT(month) DO UPDATE SET blocked_until_ms=excluded.blocked_until_ms',
          )
          .bind(new Date().toISOString().slice(0, 7), next)
          .run();
      await db
        .prepare(
          "UPDATE media_previews SET status=?,last_error=?,next_try_ms=?,lease_id=NULL,lease_until_ms=0 WHERE asset_id=? AND variant=? AND lease_id=? AND status<>'retired'",
        )
        .bind(
          quota ? 'quota' : 'failed',
          quota ? 'IMAGES_FREE_QUOTA' : 'PREVIEW_UNAVAILABLE',
          next,
          row.asset_id,
          row.variant,
          lease,
        )
        .run();
    }
  }
  return { processed };
}
export async function readPreview(
  request: Request,
  env: Env,
  id: string,
  owner: string,
  variant: number,
) {
  const row = await env.IMMICH_CF_DB.prepare(
    'SELECT * FROM media_previews WHERE asset_id=? AND owner_id=? AND variant=?',
  )
    .bind(id, owner, variant)
    .first<Preview>();
  if (!row || row.status !== 'ready')
    throw new HttpError(
      503,
      row?.status === 'quota'
        ? 'preview：Images 免费转换额度已用尽，原件已保存，额度恢复后将补生成预览'
        : 'preview：原件已保存，预览暂不可用，请稍后重试',
      'preview',
    );
  try {
    return await media(
      request,
      env.IMMICH_CF_MEDIA,
      row.object_key,
      'image/jpeg',
      row.bytes,
      row.checksum,
      true,
    );
  } catch (error) {
    await env.IMMICH_CF_DB.prepare(
      "UPDATE media_previews SET status='pending',next_try_ms=0 WHERE asset_id=? AND variant=? AND status='ready'",
    )
      .bind(id, variant)
      .run();
    throw error;
  }
}
