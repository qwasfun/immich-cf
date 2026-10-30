import type { Identity } from './auth';
import { HttpError, invalid } from './http';
import { isStorageCopyKey } from './storage-cleanup';

// Internal read-only observations. Never feed these classifications directly to
// bucket.delete: only cleanStorageCopy's transactional claim authorizes deletion.
export async function storageInventory(
  db: D1Database,
  bucket: R2Bucket,
  identity: Identity,
  input: Record<string, unknown>,
) {
  for (const field of Object.keys(input))
    if (!['mode', 'after'].includes(field)) invalid(field, '仅接受 mode 和 after，请移除此字段');
  const mode = input.mode ?? 'objects',
    after = input.after ?? '';
  if (mode !== 'objects' && mode !== 'pending') invalid('mode', '必须为 objects 或 pending');
  if (
    typeof after !== 'string' ||
    after.length > 2048 ||
    (mode === 'pending' && after !== '' && !isStorageCopyKey(after, identity.id))
  )
    invalid('after', '必须使用当前账号、当前模式上一页的 nextAfter，首次请省略');
  try {
    if (mode === 'pending') {
      const rows = await db
        .prepare(
          `SELECT object_key FROM r2_cleanup_claims
        WHERE owner_id=? AND status='claimed' AND object_key>? ORDER BY object_key LIMIT 21`,
        )
        .bind(identity.id, after)
        .all<{ object_key: string }>();
      const page = rows.results.slice(0, 20);
      // Pending jobs must remain discoverable after R2 deletion or response loss.
      if (page.some((row) => !isStorageCopyKey(row.object_key, identity.id)))
        throw new Error('INVALID_PENDING_SCOPE');
      return {
        mode,
        entries: page.map((row) => ({ key: row.object_key, status: 'claimed' })),
        nextAfter: rows.results.length > 20 ? page.at(-1)!.object_key : null,
        observationOnly: true,
        snapshotConsistent: false,
      };
    }
    const prefix = identity.id + '/';
    const listed = await bucket.list({ prefix, limit: 20, ...(after ? { cursor: after } : {}) });
    if (
      listed.objects.length > 20 ||
      listed.objects.some((object) => !object.key.startsWith(prefix))
    )
      throw new Error('INVALID_LIST_SCOPE');
    const references = await db
      .prepare(
        `SELECT k.value object_key,
        EXISTS(SELECT 1 FROM assets WHERE object_key=k.value) asset,
        EXISTS(SELECT 1 FROM assets WHERE integrity_source_key=k.value) source,
        EXISTS(SELECT 1 FROM retired_assets WHERE object_key=k.value) retired,
        EXISTS(SELECT 1 FROM retired_assets WHERE integrity_source_key=k.value) "retired-source",
        EXISTS(SELECT 1 FROM upload_intents WHERE object_key=k.value) "upload-intent",
        EXISTS(SELECT 1 FROM integrity_copy_intents WHERE object_key=k.value) "integrity-copy-intent",
        (SELECT status FROM r2_cleanup_claims WHERE object_key=k.value) cleanup
        FROM json_each(?) k`,
      )
      .bind(JSON.stringify(listed.objects.map((object) => object.key)))
      .all<{
        object_key: string;
        asset: number;
        source: number;
        retired: number;
        'retired-source': number;
        'upload-intent': number;
        'integrity-copy-intent': number;
        cleanup: string | null;
      }>();
    const kinds = new Map(references.results.map((row) => [row.object_key, row]));
    const entries = listed.objects.map((object) => {
      const observation = kinds.get(object.key);
      const refKinds = [
        'asset',
        'source',
        'retired',
        'retired-source',
        'upload-intent',
        'integrity-copy-intent',
      ] as const;
      const refs = refKinds.filter((kind) => observation?.[kind]).sort();
      const classification = refs.length
        ? 'referenced'
        : observation?.cleanup === 'claimed'
          ? 'cleanup-pending'
          : observation?.cleanup === 'done'
            ? 'cleanup-object-reappeared'
            : object.key.endsWith('/original')
              ? 'retained-original'
              : isStorageCopyKey(object.key, identity.id)
                ? 'unreferenced-copy-observed'
                : 'retained-unknown';
      return { key: object.key, bytes: object.size, references: refs, classification };
    });
    return {
      mode,
      entries,
      nextAfter: listed.truncated ? listed.cursor : null,
      observationOnly: true,
      snapshotConsistent: false,
    };
  } catch {
    // No partial page, cursor advance or private backend errors on uncertain reads.
    throw new HttpError(503, '存储检查：本页结果暂不可确认，请使用原分页位置重试');
  }
}
