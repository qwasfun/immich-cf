import type { Identity } from './auth';
import { body, invalid } from './http';
import { originalMatches } from './integrity';

// Diagnostic observations only. Neither a missing HEAD nor an old intent authorizes deletion.
export async function storageAudit(request: Request, env: Env, identity: Identity) {
  const input = await body(request);
  for (const field of Object.keys(input))
    if (field !== 'after') invalid(field, '只读检查仅接受 after 分页字段，请移除此字段');
  const after = input.after ?? '';
  if (typeof after !== 'string' || (after && !/^(asset|intent):[a-f0-9-]{36}$/i.test(after)))
    invalid('after', '必须使用上一页返回的 nextAfter，首次检查请省略此字段');
  const rows = await env.IMMICH_CF_DB.prepare(
    `SELECT * FROM (
      SELECT 'asset:' || id cursor, 'asset' kind, id, object_key, bytes, checksum,
        r2_sha1_verified, id published_id FROM assets WHERE owner_id=?
      UNION ALL
      SELECT 'intent:' || i.id cursor, 'intent' kind, i.id, i.object_key, NULL bytes,
        i.checksum, 0 r2_sha1_verified, a.id published_id
      FROM upload_intents i LEFT JOIN assets a ON a.owner_id=i.owner_id AND a.checksum=i.checksum
      WHERE i.owner_id=?
    ) WHERE cursor > ? ORDER BY cursor LIMIT 21`,
  )
    .bind(identity.id, identity.id, after)
    .all<{
      cursor: string;
      kind: string;
      id: string;
      object_key: string;
      bytes: number;
      checksum: string;
      r2_sha1_verified: number;
      published_id: string | null;
    }>();
  const page = rows.results.slice(0, 20);
  const entries = [];
  for (const row of page) {
    let objectStatus: string;
    try {
      const object = await env.IMMICH_CF_MEDIA.head(row.object_key);
      if (!object) objectStatus = 'missing';
      else if (row.kind === 'intent') objectStatus = 'present-unverified';
      else if (object.size !== row.bytes) objectStatus = 'size-mismatch';
      else if (!originalMatches(object, row.bytes, row.checksum, true))
        objectStatus = object.checksums.sha1 ? 'checksum-mismatch' : 'checksum-unavailable';
      else objectStatus = 'verified';
    } catch {
      objectStatus = 'unavailable';
    }
    entries.push({
      kind: row.kind,
      id: row.id,
      objectStatus,
      ...(row.kind === 'asset'
        ? { checksumRequired: !!row.r2_sha1_verified }
        : {
            relation: row.published_id ? 'published-checksum' : 'pending',
            publishedId: row.published_id,
          }),
    });
  }
  return Response.json({
    entries,
    nextAfter: rows.results.length > 20 ? page.at(-1)!.cursor : null,
    observationOnly: true,
    snapshotConsistent: false,
    pageObjectsVerified:
      entries.length > 0 && entries.every((entry) => entry.objectStatus === 'verified'),
  });
}
