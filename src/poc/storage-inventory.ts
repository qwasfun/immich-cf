import type { Identity } from './auth';
import { HttpError, invalid } from './http';
import { originalMatches } from './integrity';
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
  if (typeof mode !== 'string' || !['objects', 'pending', 'references'].includes(mode))
    invalid('mode', '必须为 objects、pending 或 references');
  if (
    typeof after !== 'string' ||
    after.length > 2048 ||
    (mode === 'pending' && after !== '' && !isStorageCopyKey(after, identity.id))
  )
    invalid('after', '必须使用当前账号、当前模式上一页的 nextAfter，首次请省略');
  if (
    mode === 'references' &&
    after &&
    !/^(asset|source|intent|retired|retired-source):[a-f0-9-]{36}$/i.test(after) &&
    !/^preview:[a-f0-9-]{36}:(256|2048)$/i.test(after) &&
    !/^staging:[a-f0-9-]{36}$/i.test(after) &&
    !after.startsWith('copy:' + identity.id + '/')
  )
    invalid('after', '必须使用当前 references 页的 nextAfter，首次请省略');
  try {
    if (mode === 'references') {
      // Six independent bounded reads avoid D1's compound-SELECT limit. Batch
      // provides a shared D1 snapshot; never interpolate user input into SQL.
      const sources = [
        ['asset', 'assets', 'id', 'object_key', 'bytes', 'checksum', 'r2_sha1_verified'],
        [
          'preview',
          'media_previews',
          "asset_id||':'||variant",
          'object_key',
          'bytes',
          'checksum',
          '1',
        ],
        ['staging', 'media_upload_staging', 'id', 'object_key', 'bytes', 'checksum', '0'],
        ['copy', 'integrity_copy_intents', 'object_key', 'object_key', 'NULL', 'NULL', '0'],
        ['intent', 'upload_intents', 'id', 'object_key', 'NULL', 'checksum', '0'],
        ['retired', 'retired_assets', 'id', 'object_key', 'bytes', 'checksum', 'r2_sha1_verified'],
        [
          'retired-source',
          'retired_assets',
          'id',
          'integrity_source_key',
          'bytes',
          'checksum',
          '0',
        ],
        ['source', 'assets', 'id', 'integrity_source_key', 'bytes', 'checksum', '0'],
      ] as const;
      const batches = await db.batch<{
        cursor: string;
        kind: string;
        object_key: string;
        bytes: number;
        checksum: string;
        required: number;
      }>(
        sources.map(([kind, table, id, key, bytes, checksum, required]) =>
          db
            .prepare(
              `SELECT /* inventory references */ '${kind}:'||${id} cursor,'${kind}' kind,${key} object_key,${bytes} bytes,${checksum} checksum,${required} required FROM ${table} WHERE owner_id=? AND ${key} IS NOT NULL AND '${kind}:'||${id}>? ORDER BY cursor LIMIT 21`,
            )
            .bind(identity.id, after),
        ),
      );
      const rows = {
        results: batches
          .flatMap((batch) => batch.results)
          .sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0))
          .slice(0, 21),
      };
      const page = rows.results.slice(0, 20);
      if (page.some((row) => !row.object_key.startsWith(identity.id + '/')))
        throw new Error('INVALID_REFERENCE_SCOPE');
      const entries = [];
      for (const row of page) {
        const purge = ['retired', 'retired-source', 'copy'].includes(row.kind)
          ? await db
              .prepare(
                'SELECT j.status FROM asset_purge_jobs j JOIN asset_purge_objects o ON o.asset_id=j.asset_id AND o.owner_id=j.owner_id WHERE j.owner_id=? AND o.object_key=? LIMIT 1',
              )
              .bind(identity.id, row.object_key)
              .first<{ status: string }>()
          : null;
        let objectStatus: string;
        try {
          const object = await bucket.head(row.object_key);
          objectStatus = !object
            ? purge?.status === 'done'
              ? 'deleted'
              : 'missing'
            : row.kind === 'copy' || row.kind === 'intent'
              ? 'present-unverified'
              : object.size !== row.bytes
                ? 'size-mismatch'
                : originalMatches(object, row.bytes, row.checksum, true)
                  ? 'verified'
                  : object.checksums.sha1
                    ? 'checksum-mismatch'
                    : 'checksum-unavailable';
        } catch {
          objectStatus = 'unavailable';
        }
        entries.push({
          key: row.object_key,
          kind: row.kind,
          objectStatus,
          checksumRequired: !!row.required,
          ...(purge ? { permanentDeleteRequested: true, purgeStatus: purge.status } : {}),
        });
      }
      return {
        mode,
        entries,
        nextAfter: rows.results.length > 20 ? page.at(-1)!.cursor : null,
        observationOnly: true,
        snapshotConsistent: false,
      };
    }
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
        EXISTS(SELECT 1 FROM media_previews WHERE object_key=k.value) preview,
        EXISTS(SELECT 1 FROM media_upload_staging WHERE object_key=k.value AND status<>'deleted') staging,
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
        preview: number;
        staging: number;
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
        'preview',
        'staging',
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
