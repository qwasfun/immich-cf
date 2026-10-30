import type { Identity } from './auth';
import { HttpError, invalid } from './http';

const uuid = (v: string | null, field: string) => {
  if (!v || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v))
    invalid(field, '请提供有效 UUID v4');
  return v.toLowerCase();
};
export async function requireOperator(db: D1Database, identity: Identity) {
  const row = await db
    .prepare(
      `SELECT u.id FROM users u JOIN operations_admins a ON a.user_id=u.id JOIN sessions s ON s.user_id=u.id
    WHERE u.id=? AND s.id=? AND u.disabled=0 AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`,
    )
    .bind(identity.id, identity.session_id, Date.now())
    .first();
  if (!row) throw new HttpError(403, '管理员权限：会话或运维授权已失效，请联系部署维护者核对授权');
}
export async function admin(request: Request, env: Env, identity: Identity) {
  const db = env.IMMICH_CF_DB,
    url = new URL(request.url),
    path = url.pathname;
  await requireOperator(db, identity);
  const allowed = path.endsWith('/status')
    ? []
    : path.endsWith('/original')
      ? ['userId', 'id', 'revision']
      : ['userId'];
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key)) invalid(key, '此接口不接受该字段，请移除');
  if (path.endsWith('/status')) {
    const result = await db.batch([
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM assets) assets,
      (SELECT COUNT(*) FROM assets WHERE deleted_at IS NOT NULL) trashed,(SELECT COALESCE(SUM(bytes),0) FROM assets) logicalBytes,
      (SELECT COUNT(*) FROM upload_intents) uploadReservations,(SELECT COUNT(*) FROM integrity_copy_intents) copyReservations,
      (SELECT COUNT(*) FROM albums) albums,(SELECT COUNT(*) FROM sessions WHERE expires_at>?) sessions`,
        )
        .bind(Date.now()),
      db.prepare('SELECT status,COUNT(*) total FROM asset_purge_jobs GROUP BY status'),
      db.prepare('SELECT COUNT(*) total FROM d1_migrations'),
    ]);
    await requireOperator(db, identity);
    return Response.json({
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      snapshotConsistent: false,
      counts: result[0]!.results[0],
      purge: result[1]!.results,
      migrations: result[2]!.results[0],
      limits: { uploadBytes: 4194304, pixels: 64000000, maxEdge: 16384, logicalAssetsPerUser: 20 },
      supported: {
        images: ['image/jpeg', 'image/png'],
        livePhoto: false,
        video: false,
        heic: false,
      },
      accounting: {
        logicalBytesIncludeTrash: true,
        physicalR2UsageMeasured: false,
        providerBillingMeasured: false,
      },
      export: {
        format: 'immich-cf-account-v1',
        includesTrash: true,
        fullDatabaseBackup: false,
        restoreVerified: false,
      },
    });
  }
  const owner = uuid(url.searchParams.get('userId'), 'userId');
  if (!(await db.prepare('SELECT id FROM users WHERE id=?').bind(owner).first()))
    throw new HttpError(404, 'userId：账号不存在，请核对账号ID', 'userId');
  if (path.endsWith('/original')) {
    const id = uuid(url.searchParams.get('id'), 'id'),
      revision = url.searchParams.get('revision');
    if (!revision || !/^\d{1,16}$/.test(revision))
      invalid('revision', '请使用导出清单中的资产版本');
    const row = await db
      .prepare('SELECT * FROM assets WHERE id=? AND owner_id=? AND sync_seq=?')
      .bind(id, owner, Number(revision))
      .first<{ object_key: string; bytes: number; checksum: string; mime: string }>();
    if (!row)
      throw new HttpError(409, 'id/revision：资产已变化或删除，请重新导出清单', 'id/revision');
    if (row.bytes < 1 || row.bytes > 4194304)
      throw new HttpError(409, 'id：资产大小超出当前安全导出范围，请核对存储', 'id');
    const object = await env.IMMICH_CF_MEDIA.get(row.object_key);
    if (!object) throw new HttpError(409, 'id：原图缺失，请先执行存储对账', 'id');
    if (object.size !== row.bytes) {
      await object.body.cancel();
      throw new HttpError(409, 'id：原图大小异常，请先执行存储对账', 'id');
    }
    const bytes = await object.arrayBuffer();
    const hash = btoa(
      String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))),
    );
    if (bytes.byteLength !== row.bytes || hash !== row.checksum)
      throw new HttpError(409, 'id：原图校验不符，请先执行存储对账', 'id');
    await requireOperator(db, identity);
    const current = await db
      .prepare(
        'SELECT id FROM assets WHERE id=? AND owner_id=? AND sync_seq=? AND object_key=? AND checksum=?',
      )
      .bind(id, owner, Number(revision), row.object_key, row.checksum)
      .first();
    if (!current)
      throw new HttpError(409, 'id/revision：下载期间资产已变化，请重新导出清单', 'id/revision');
    return new Response(bytes, {
      headers: {
        'Content-Type': row.mime,
        'Content-Disposition': `attachment; filename="${id}.${row.mime === 'image/png' ? 'png' : 'jpg'}"`,
      },
    });
  }
  const data = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT id,filename,mime,bytes,checksum,width,height,file_created_at,file_modified_at,created_at,updated_at,deleted_at,favorite,metadata,sync_seq FROM assets WHERE owner_id=? ORDER BY id LIMIT 21',
      )
      .bind(owner),
    db
      .prepare(
        'SELECT id,name,description,thumbnail_asset_id,sort_order,created_at,updated_at FROM albums WHERE owner_id=? ORDER BY id LIMIT 101',
      )
      .bind(owner),
    db
      .prepare(
        'SELECT album_id,asset_id FROM album_assets WHERE owner_id=? ORDER BY album_id,asset_id LIMIT 2001',
      )
      .bind(owner),
  ]);
  if (
    data[0]!.results.length > 20 ||
    data[1]!.results.length > 100 ||
    data[2]!.results.length > 2000
  )
    throw new HttpError(409, '导出范围：超过当前单账号安全上限，请使用后续分批导出工具');
  await requireOperator(db, identity);
  const assets = data[0]!.results.map((row) => ({
    ...row,
    downloadPath: `/api/immich-cf/admin/export/original?userId=${owner}&id=${row.id}&revision=${row.sync_seq}`,
  }));
  return Response.json(
    {
      format: 'immich-cf-account-v1',
      ownerId: owner,
      exportedAt: new Date().toISOString(),
      includesTrash: true,
      fullDatabaseBackup: false,
      assets,
      albums: data[1]!.results,
      relations: data[2]!.results,
    },
    { headers: { 'Content-Disposition': 'attachment; filename="immich-cf-manifest.json"' } },
  );
}
