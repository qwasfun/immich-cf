// Durable, explicitly authorized permanent-deletion jobs. Normal orphan GC keeps
// its stricter original/reservation retention policy; it cannot create these jobs.
export async function runPurgeJobs(
  env: Env,
  options: { ownerId?: string; assetIds?: string[]; limit?: number } = {},
) {
  const db = env.IMMICH_CF_DB,
    limit = Math.min(3, Math.max(1, options.limit ?? 3));
  const where = options.ownerId ? ' AND owner_id=?' : '';
  const specific = options.assetIds?.length
    ? ' AND asset_id IN(SELECT value FROM json_each(?))'
    : '';
  const due = specific ? '' : ' AND next_check_ms<=?';
  const args: (string | number)[] = [
    ...(options.ownerId ? [options.ownerId] : []),
    ...(specific ? [JSON.stringify(options.assetIds)] : []),
    ...(!specific ? [Date.now()] : []),
    limit,
  ];
  const jobs = await db
    .prepare(
      `SELECT asset_id,owner_id FROM asset_purge_jobs WHERE 1${where}${specific}${due} ORDER BY next_check_ms,asset_id LIMIT ?`,
    )
    .bind(...args)
    .all<{ asset_id: string; owner_id: string }>();
  let completed = 0;
  for (const job of jobs.results) {
    let blocked = false;
    try {
      const objects = await db
        .prepare(
          'SELECT object_key,checked_at FROM asset_purge_objects WHERE asset_id=? ORDER BY checked_at,object_key LIMIT 2',
        )
        .bind(job.asset_id)
        .all<{ object_key: string; checked_at: number }>();
      for (const object of objects.results) {
        try {
          await db.batch([
            db
              .prepare(
                'INSERT INTO asset_purge_fences(object_key,asset_id,owner_id) VALUES(?,?,?) ON CONFLICT(object_key) DO NOTHING',
              )
              .bind(object.object_key, job.asset_id, job.owner_id),
          ]);
          await env.IMMICH_CF_MEDIA.delete(object.object_key);
          const remaining = await env.IMMICH_CF_MEDIA.head(object.object_key);
          await db
            .prepare(
              'UPDATE asset_purge_objects SET status=?,checked_at=? WHERE asset_id=? AND object_key=? AND checked_at=?',
            )
            .bind(
              remaining ? 'pending' : 'done',
              Date.now(),
              job.asset_id,
              object.object_key,
              object.checked_at,
            )
            .run();
        } catch (error) {
          if (
            String(error).includes('PURGE_REFERENCED') ||
            String(error).includes('PURGE_UNAUTHORIZED')
          )
            blocked = true;
          await db
            .prepare(
              "UPDATE asset_purge_objects SET status='pending',checked_at=? WHERE asset_id=? AND object_key=? AND checked_at=?",
            )
            .bind(Date.now(), job.asset_id, object.object_key, object.checked_at)
            .run();
        }
      }
      const counts = (await db
        .prepare(
          "SELECT COUNT(*) total,COALESCE(SUM(status<>'done'),0) pending FROM asset_purge_objects WHERE asset_id=?",
        )
        .bind(job.asset_id)
        .first<{ total: number; pending: number }>())!;
      const done = counts.total > 0 && counts.pending === 0;
      await db
        .prepare('UPDATE asset_purge_jobs SET status=?,next_check_ms=? WHERE asset_id=?')
        .bind(done ? 'done' : blocked ? 'blocked' : 'queued', Date.now() + 5 * 60000, job.asset_id)
        .run();
      if (done) completed++;
    } catch {
      // Keep the durable intent on any uncertain DB/R2 result; never log raw errors.
      try {
        await db
          .prepare("UPDATE asset_purge_jobs SET status='queued',next_check_ms=? WHERE asset_id=?")
          .bind(Date.now() + 5 * 60000, job.asset_id)
          .run();
      } catch {
        /* Existing queued job remains recoverable. */
      }
    }
  }
  return { processed: jobs.results.length, completed };
}
