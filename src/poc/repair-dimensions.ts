import type { Identity } from './auth';
import { body, HttpError, invalid } from './http';
import { imageHeader } from './image-header';
import { MAX_IMAGE } from './assets';

export async function repairDimensions(request: Request, env: Env, identity: Identity) {
  const input = await body(request);
  if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id))
    invalid('id', '请提供有效资产 ID');
  if (input.apply !== undefined && typeof input.apply !== 'boolean')
    invalid('apply', '必须为 true 或 false');
  const row = await env.IMMICH_CF_DB.prepare(
    'SELECT id,object_key,checksum,bytes,mime,width,height,sync_seq FROM assets WHERE id=? AND owner_id=?',
  )
    .bind(input.id, identity.id)
    .first<{
      id: string;
      object_key: string;
      checksum: string;
      bytes: number;
      mime: string;
      width: number;
      height: number;
      sync_seq: number;
    }>();
  if (!row) throw new HttpError(404, '图片不存在或无权访问');
  const object = await env.IMMICH_CF_MEDIA.get(row.object_key);
  if (!object) throw new HttpError(503, '原图暂不可读取，请恢复原图后重试');
  if (object.size !== row.bytes || object.size > MAX_IMAGE) {
    await object.body.cancel();
    throw new HttpError(409, '原图大小与记录不一致，未修复');
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const hash = btoa(
    String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))),
  );
  if (hash !== row.checksum) throw new HttpError(409, '原图校验和与记录不一致，未修复');
  const info = imageHeader(bytes);
  if (info.mime !== row.mime) throw new HttpError(409, '原图格式与记录不一致，未修复');
  const changed = info.width !== row.width || info.height !== row.height;
  const result = {
    id: row.id,
    before: [row.width, row.height],
    after: [info.width, info.height],
    changed,
  };
  if (!changed || input.apply !== true) return Response.json({ ...result, applied: false });
  // A single statement and its trigger atomically publish dimensions + a new cursor.
  // CAS rejects races; recheck session validity at commit after R2 awaits.
  const [write] = await env.IMMICH_CF_DB.batch([
    env.IMMICH_CF_DB.prepare(
      `UPDATE assets SET width=?,height=?
      WHERE id=? AND owner_id=? AND sync_seq=? AND width=? AND height=? AND checksum=? AND object_key=?
      AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=? AND s.user_id=? AND s.expires_at>? AND u.disabled=0)`,
    ).bind(
      info.width,
      info.height,
      row.id,
      identity.id,
      row.sync_seq,
      row.width,
      row.height,
      row.checksum,
      row.object_key,
      identity.session_id,
      identity.id,
      Date.now(),
    ),
  ]);
  if (!write?.meta.changes)
    throw new HttpError(409, '资产或会话已改变，请重新登录或重新预检后重试');
  return Response.json({ ...result, applied: true });
}
