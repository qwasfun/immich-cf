import type { Identity } from './auth';
import { body, HttpError, invalid } from './http';
import { MAX_IMAGE } from './multipart';
import { originalMatches } from './integrity';

// Copy-on-write: retain the source and all upload intents, even on uncertain outcomes.
export async function upgradeIntegrity(request: Request, env: Env, identity: Identity) {
  try {
    return await upgrade(request, env, identity);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      'id：升级结果暂不可确认，请稍后对同一资产重新预检并重试；原图和预约均保留',
      'id',
    );
  }
}

async function upgrade(request: Request, env: Env, identity: Identity) {
  const input = await body(request);
  for (const field of Object.keys(input))
    if (!['id', 'apply'].includes(field)) invalid(field, '仅接受 id 和 apply，请移除此字段');
  if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id))
    invalid('id', '请提供有效资产 ID');
  if (input.apply !== undefined && typeof input.apply !== 'boolean')
    invalid('apply', '必须为 true 或 false；请先省略或设为 false 进行预检');
  const row = await env.IMMICH_CF_DB.prepare(
    'SELECT id,object_key,checksum,bytes,sync_seq,r2_sha1_verified,integrity_source_key FROM assets WHERE id=? AND owner_id=?',
  )
    .bind(input.id, identity.id)
    .first<{
      id: string;
      object_key: string;
      checksum: string;
      bytes: number;
      sync_seq: number;
      r2_sha1_verified: number;
      integrity_source_key: string | null;
    }>();
  if (!row) throw new HttpError(404, '图片不存在或无权访问');
  const conflict = () =>
    new HttpError(
      409,
      'id：原图或资产状态不满足升级条件，请保留原件并恢复同一图片后重新预检',
      'id',
    );
  let recovering = false;
  if (row.r2_sha1_verified) {
    if (
      !originalMatches(
        await env.IMMICH_CF_MEDIA.head(row.object_key),
        row.bytes,
        row.checksum,
        true,
      )
    ) {
      if (!row.integrity_source_key || row.integrity_source_key === row.object_key)
        throw conflict();
      recovering = true;
    } else
      return Response.json({
        id: row.id,
        alreadyVerified: true,
        applied: false,
        originalRetained: !!row.integrity_source_key,
      });
  }
  const result = { id: row.id, alreadyVerified: false, originalRetained: true, recovering };
  if (row.bytes < 1 || row.bytes > MAX_IMAGE) throw conflict();
  const sourceKey = recovering ? row.integrity_source_key! : row.object_key;
  const source = await env.IMMICH_CF_MEDIA.get(sourceKey);
  if (!source) throw conflict();
  if (source.size !== row.bytes) {
    await source.body.cancel();
    throw conflict();
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  const sha1 = await crypto.subtle.digest('SHA-1', bytes);
  const digest = new Uint8Array(sha1);
  if (bytes.length !== row.bytes || btoa(String.fromCharCode(...digest)) !== row.checksum)
    throw conflict();
  if (input.apply !== true)
    return Response.json({ ...result, applied: false, sourceBytesVerified: true });
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const target = recovering ? row.object_key : `${identity.id}/${row.id}/verified-sha1-${hex}`;
  // Initial staging is create-only. Recovery may conditionally replace a bad copy,
  // using fully rehashed retained source bytes, never overwriting the retained source.
  let copy = await env.IMMICH_CF_MEDIA.head(target);
  if (!copy || (recovering && !originalMatches(copy, row.bytes, row.checksum, true))) {
    copy = await env.IMMICH_CF_MEDIA.put(target, bytes, {
      onlyIf: copy ? { etagMatches: copy.etag } : { etagDoesNotMatch: '*' },
      sha1,
      httpMetadata: source.httpMetadata ?? {},
      customMetadata: source.customMetadata ?? {},
      storageClass: source.storageClass,
    });
    // Another upgrader may have created it after HEAD. Verify it rather than overwriting.
    if (!copy) copy = await env.IMMICH_CF_MEDIA.head(target);
  }
  if (!originalMatches(copy, row.bytes, row.checksum, true)) throw conflict();
  const [write] = await env.IMMICH_CF_DB.batch([
    env.IMMICH_CF_DB.prepare(
      `UPDATE assets SET r2_sha1_verified=1,object_key=?,integrity_source_key=?
       WHERE id=? AND owner_id=? AND object_key=? AND checksum=? AND bytes=? AND sync_seq=? AND r2_sha1_verified=? AND integrity_source_key IS ?
       AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.id=? AND s.user_id=? AND s.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND u.disabled=0)`,
    ).bind(
      target,
      sourceKey,
      row.id,
      identity.id,
      row.object_key,
      row.checksum,
      row.bytes,
      row.sync_seq,
      row.r2_sha1_verified,
      row.integrity_source_key,
      identity.session_id,
      identity.id,
    ),
  ]);
  if (!write?.meta.changes)
    throw new HttpError(
      409,
      'id：资产或会话已改变，请重新登录或重新预检后重试；原图和校验副本均已保留',
      'id',
    );
  return Response.json({ ...result, applied: true, sourceBytesVerified: true });
}
