import type { Identity } from './auth';
import type { Asset } from './assets';
import { digest, HttpError, invalid } from './http';
import { originalMatches } from './integrity';
import { inspectMedia, MAX_PHOTO } from './media-format';
import { stageUpload, cleanStaging } from './media-staging';
import { guardLivePhoto } from './live-photo';
import { queuePreviews } from './previews';

function assetLimit(missingMotion = false): never {
  throw new HttpError(
    409,
    `assetData：账户已达 20 个逻辑资产上限（含回收站和待完成上传）${missingMotion ? '，动态视频尚未完成，照片也不能完成整组备份' : ''}；请先确认已有项目已另行备份，再永久删除不需要的项目以释放名额，然后重试备份`,
    'assetData',
  );
}
export async function completeOriginals(env: Env, row: Asset): Promise<boolean> {
  if (
    !originalMatches(
      await env.IMMICH_CF_MEDIA.head(row.object_key),
      row.bytes,
      row.checksum,
      !!row.r2_sha1_verified,
    )
  )
    return false;
  if (row.live_photo_video_id) {
    const video = await env.IMMICH_CF_DB.prepare(
      "SELECT * FROM assets WHERE id=? AND owner_id=? AND media_type='VIDEO' AND visibility='hidden' AND pair_id=? AND deleted_at IS ?",
    )
      .bind(row.live_photo_video_id, row.owner_id, row.pair_id, row.deleted_at)
      .first<Asset>();
    if (
      !video ||
      !originalMatches(
        await env.IMMICH_CF_MEDIA.head(video.object_key),
        video.bytes,
        video.checksum,
        !!video.r2_sha1_verified,
      )
    )
      return false;
  }
  return true;
}
export async function uploadLive(request: Request, env: Env, identity: Identity) {
  const staged = await stageUpload(request, env, identity.id),
    db = env.IMMICH_CF_DB,
    form = staged.fields;
  let mediaType: string | undefined;
  try {
    for (const key of ['deviceId', 'deviceAssetId']) {
      const v = form.get(key);
      if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 255))
        invalid(key, '必须为非空字符串，最多 255 字符');
    }
    const visibility = form.get('visibility') ?? 'timeline';
    if (!['timeline', 'hidden'].includes(String(visibility)))
      invalid('visibility', '必须为 timeline 或 Live Photo 动态部分的 hidden');
    if (form.has('sidecarData')) invalid('sidecarData', '当前不支持侧车文件，请移除此字段');
    const favorite = form.get('isFavorite') ?? 'false';
    if (!['true', 'false'].includes(String(favorite)))
      invalid('isFavorite', '必须填写 true 或 false');
    if (form.has('duration') && !/^\d+(?:\.\d+)?$/.test(String(form.get('duration'))))
      invalid('duration', '请填写非负数字时长');
    const date = (field: string) => {
      const raw = form.get(field);
      if (
        typeof raw !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ||
        !Number.isFinite(Date.parse(raw))
      )
        invalid(field, '请填写带时区的有效 ISO 日期时间');
      const [y, m, d] = raw.slice(0, 10).split('-').map(Number) as [number, number, number];
      if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate())
        invalid(field, '日期不存在，请检查年月日');
      return new Date(raw).toISOString();
    };
    const created = date('fileCreatedAt'),
      modified = date('fileModifiedAt'),
      name = form.get('filename') ?? staged.filename;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 255 ||
      /[\x00-\x1f\\/]/.test(name)
    )
      invalid('filename', '请使用不含路径和控制字符的文件名，最多 255 字符');
    let metadata: { key: string; value: Record<string, unknown> }[] = [];
    if (form.has('metadata')) {
      try {
        metadata = JSON.parse(String(form.get('metadata')));
      } catch {
        invalid('metadata', '请提供有效 JSON 数组');
      }
      if (
        !Array.isArray(metadata) ||
        metadata.length > 1 ||
        metadata.some(
          (x) =>
            !x ||
            x.key !== 'mobile-app' ||
            !x.value ||
            typeof x.value !== 'object' ||
            Array.isArray(x.value),
        )
      )
        invalid('metadata', '当前只支持一项 mobile-app 对象');
    }
    let info;
    try {
      info = await inspectMedia(env.IMMICH_CF_MEDIA, staged.key, staged.size);
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError)
        invalid('assetData', '媒体容器或配对元数据不完整，请重新选择未修改的原件');
      throw error;
    }
    mediaType = info.type;
    if (info.type === 'IMAGE' && staged.size > MAX_PHOTO)
      throw new HttpError(
        413,
        'assetData：照片最多 20,000,000 字节，请选择符合上限的原件',
        'assetData',
      );
    const expected = request.headers.get('x-immich-checksum');
    if (expected) {
      const normalized = /^[a-f0-9]{40}$/i.test(expected)
        ? btoa(String.fromCharCode(...expected.match(/../g)!.map((x) => parseInt(x, 16))))
        : expected;
      if (normalized !== staged.hash)
        invalid('x-immich-checksum', '与文件内容不符，请重新计算后上传');
    }
    const linked = form.get('livePhotoVideoId');
    if (info.type === 'VIDEO') {
      if (visibility !== 'hidden')
        invalid('visibility', 'Live Photo 动态视频必须使用 hidden；当前不支持独立视频');
      if (linked !== null)
        invalid('livePhotoVideoId', '动态视频不能引用其他视频，请仅在照片上传时填写');
    } else if (visibility !== 'timeline')
      invalid('visibility', '照片必须使用 timeline，动态部分应上传 MOV 原件');
    if (info.marked && !info.pair)
      invalid('assetData', 'Live Photo 缺少有效配对标识，请重新选择照片和动态原件');
    const pairId = info.pair ? await digest(info.pair) : null,
      logical = pairId ? `live:${pairId}` : `sha1:${staged.hash}`;
    if (info.type === 'IMAGE' && info.pair && !linked) {
      // Official iOS continues with the still after a rejected motion upload.
      // Preserve the actual quota cause instead of masking it with a missing-ID error.
      if (
        await db
          .prepare(
            'SELECT 1 WHERE (SELECT COUNT(*) FROM logical_asset_slots WHERE owner_id=?)>=20 AND NOT EXISTS(SELECT 1 FROM logical_asset_slots WHERE owner_id=? AND slot=?)',
          )
          .bind(identity.id, identity.id, logical)
          .first()
      )
        assetLimit(true);
      invalid('livePhotoVideoId', 'Live Photo 必须先完整上传动态视频，再提交返回的视频 ID');
    }
    if (linked !== null && (typeof linked !== 'string' || !/^[a-f0-9-]{36}$/i.test(linked)))
      invalid('livePhotoVideoId', '请使用动态视频上传返回的有效资产 ID');
    const verifyVideo = async () => {
      if (!linked) return;
      if (!pairId)
        invalid('assetData/livePhotoVideoId', '照片缺少配对元数据，请选择与动态视频配套的原件');
      const v = await db
        .prepare(
          "SELECT * FROM assets WHERE id=? AND owner_id=? AND media_type='VIDEO' AND visibility='hidden' AND pair_id=? AND deleted_at IS NULL",
        )
        .bind(linked, identity.id, pairId)
        .first<Asset>();
      if (!v) invalid('livePhotoVideoId', '视频不存在、配对不符或已删除，请先重新备份对应动态原件');
      if (!(await completeOriginals(env, v)))
        throw new HttpError(
          409,
          'livePhotoVideoId：动态原件缺失或校验异常，请先重传对应视频',
          'livePhotoVideoId',
        );
    };
    await verifyVideo();
    if (!pairId) await guardLivePhoto(form, db, identity.id);
    if (
      pairId &&
      (await db
        .prepare(
          'SELECT 1 FROM assets WHERE owner_id=? AND pair_id=? AND media_type=? AND checksum<>?',
        )
        .bind(identity.id, pairId, info.type, staged.hash)
        .first())
    )
      invalid('assetData/livePhotoVideoId', '该配对已保存其他原件，请核对文件，不能替换已有配对');
    const find = () =>
      db
        .prepare('SELECT * FROM assets WHERE owner_id=? AND checksum=?')
        .bind(identity.id, staged.hash)
        .first<Asset>();
    const copy = async (key: string) => {
      const source = await env.IMMICH_CF_MEDIA.get(staged.key);
      if (!source || source.size !== staged.size)
        throw new HttpError(503, 'assetData：暂存文件未确认，请重新上传同一原件', 'assetData');
      const saved = await env.IMMICH_CF_MEDIA.put(key, source.body, {
        sha1: staged.sha1,
        httpMetadata: { contentType: info.mime },
      });
      if (!originalMatches(saved, staged.size, staged.hash, true))
        throw new HttpError(503, 'assetData：原件校验暂未确认，请重试同一文件', 'assetData');
    };
    const duplicate = async (row: Asset) => {
      if (
        row.media_type !== info.type ||
        row.visibility !== visibility ||
        row.pair_id !== pairId ||
        row.live_photo_video_id !== (linked ?? null)
      )
        invalid(
          'livePhotoVideoId/assetData',
          '已有原件的配对关系不同，请核对原件；不能替换已有配对',
        );
      await verifyVideo();
      if (
        !originalMatches(
          await env.IMMICH_CF_MEDIA.head(row.object_key),
          row.bytes,
          row.checksum,
          true,
        )
      )
        await copy(row.object_key);
      await db
        .prepare('UPDATE assets SET r2_sha1_verified=1 WHERE id=? AND owner_id=?')
        .bind(row.id, identity.id)
        .run();
      const live = await db
        .prepare(
          `SELECT a.id FROM assets a JOIN sessions s ON s.user_id=a.owner_id JOIN users u ON u.id=s.user_id WHERE a.id=? AND a.object_key=? AND a.owner_id=? AND s.id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0`,
        )
        .bind(row.id, row.object_key, identity.id, identity.session_id, Date.now())
        .first();
      if (!live)
        throw new HttpError(409, 'assetData：资产或会话已改变，请重新同步后重试', 'assetData');
      await queuePreviews(env, row.id);
      return Response.json({ id: row.id, status: 'duplicate' });
    };
    const existing = await find();
    if (existing) return await duplicate(existing);
    const candidate = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO upload_intents(owner_id,checksum,id,object_key,created_at,logical_key,media_role) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM assets WHERE owner_id=? AND checksum=?) ON CONFLICT(owner_id,checksum) DO NOTHING`,
      )
      .bind(
        identity.id,
        staged.hash,
        candidate,
        `${identity.id}/${candidate}/original`,
        new Date().toISOString(),
        logical,
        info.type,
        identity.id,
        staged.hash,
      )
      .run();
    const intent = await db
      .prepare('SELECT * FROM upload_intents WHERE owner_id=? AND checksum=?')
      .bind(identity.id, staged.hash)
      .first<{ id: string; object_key: string; created_at: string; logical_key: string }>();
    if (!intent) {
      const row = await find();
      if (row) return await duplicate(row);
      throw new HttpError(503, 'assetData：上传状态暂不可确认，请重试同一原件', 'assetData');
    }
    if (
      (intent.logical_key !== logical &&
        !(intent.logical_key === '' && logical === `sha1:${staged.hash}`)) ||
      (await db.prepare('SELECT id FROM retired_assets WHERE id=?').bind(intent.id).first())
    )
      throw new HttpError(
        409,
        'assetData：保留预约与当前原件状态冲突，请先核对上传状态',
        'assetData',
      );
    await copy(intent.object_key);
    await verifyVideo();
    const result = await db.batch([
      db
        .prepare(
          `INSERT INTO assets(id,owner_id,checksum,object_key,filename,mime,bytes,width,height,created_at,file_created_at,file_modified_at,favorite,metadata,r2_sha1_verified,media_type,visibility,duration,pair_id,live_photo_video_id,logical_key)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) AND u.disabled=0)
      AND EXISTS(SELECT 1 FROM media_upload_staging WHERE id=? AND status='ready' AND expires_ms>?) ON CONFLICT(owner_id,checksum) DO NOTHING`,
        )
        .bind(
          intent.id,
          identity.id,
          staged.hash,
          intent.object_key,
          name,
          info.mime,
          staged.size,
          info.width,
          info.height,
          intent.created_at,
          created,
          modified,
          favorite === 'true' ? 1 : 0,
          JSON.stringify(metadata),
          info.type,
          visibility,
          info.duration,
          pairId,
          linked ?? null,
          logical,
          identity.session_id,
          identity.id,
          Date.now(),
          staged.id,
          Date.now(),
        ),
      db
        .prepare(
          'DELETE FROM upload_intents WHERE owner_id=? AND checksum=? AND EXISTS(SELECT 1 FROM assets WHERE id=?)',
        )
        .bind(identity.id, staged.hash, intent.id),
    ]);
    const row = await find();
    if (!row)
      throw new HttpError(409, 'assetData：会话或上传状态已改变，请重新同步后重试', 'assetData');
    if (row.id !== intent.id) return await duplicate(row);
    await queuePreviews(env, row.id);
    return Response.json(
      { id: row.id, status: result[0]!.meta.changes ? 'created' : 'duplicate' },
      { status: result[0]!.meta.changes ? 201 : 200 },
    );
  } catch (error) {
    // The official client can hide the motion HTTP failure. Log only our fixed
    // category, status and media type, never filenames, metadata or submitted values.
    console.log(
      JSON.stringify({
        code: String(error).includes('ASSET_LIMIT')
          ? 'MEDIA_UPLOAD_ASSET_LIMIT'
          : 'MEDIA_UPLOAD_REJECTED',
        status: String(error).includes('ASSET_LIMIT')
          ? 409
          : error instanceof HttpError
            ? error.status
            : 503,
        mediaType: mediaType ?? 'unknown',
      }),
    );
    if (error instanceof HttpError) throw error;
    const message = String(error);
    if (message.includes('ASSET_LIMIT')) assetLimit();
    if (
      message.includes('LIVE_PHOTO') ||
      message.includes('upload_intents.owner_id') ||
      message.includes('assets.owner_id, assets.pair_id') ||
      message.includes('assets.live_photo_video_id')
    )
      invalid(
        'livePhotoVideoId/assetData',
        '配对关系已变化或已有其他原件，请重新同步并核对配套文件',
      );
    throw new HttpError(
      503,
      'assetData：原件保存结果暂不可确认，请恢复网络后重试同一原件',
      'assetData',
    );
  } finally {
    await db
      .prepare(
        "UPDATE media_upload_staging SET status='complete',expires_ms=? WHERE id=? AND status='ready'",
      )
      .bind(Date.now(), staged.id)
      .run()
      .catch(() => undefined);
    await cleanStaging(env, staged.id).catch(() => undefined);
  }
}
