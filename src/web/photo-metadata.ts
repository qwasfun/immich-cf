import { authenticate, type Identity } from '../poc/auth';
import { body, HttpError } from '../poc/http';
import type { Asset } from '../poc/assets';
import { readPhotoExif } from './photo-extraction';
import { photoRecord, photoExifDto } from '../poc/photo-details';
import { PhotoTimeError, photoTimeZone, photoWallTime, resolvePhotoTime } from '../photo-time';
import { field, only, sameOrigin, uuid } from './common';
import type { PhotoMetadataData } from '../photo-info';

const revision = (db: D1Database, owner: string) =>
  db
    .prepare(
      'SELECT COALESCE((SELECT revision FROM asset_owner_revisions WHERE owner_id=?),0) version',
    )
    .bind(owner);
async function snapshot(db: D1Database, owner: string, ids: string[]) {
  const [state, assets] = await db.batch([
    revision(db, owner),
    db
      .prepare(
        "SELECT * FROM assets WHERE owner_id=? AND media_type='IMAGE' AND visibility='timeline' AND id IN(SELECT value FROM json_each(?)) ORDER BY id",
      )
      .bind(owner, JSON.stringify(ids)),
  ]);
  if (assets!.results.length !== ids.length)
    throw new HttpError(404, '所选照片：不存在或无权访问，请刷新后重新选择', 'ids');
  return {
    version: String((state!.results[0] as { version: number }).version),
    rows: assets!.results as unknown as Asset[],
  };
}
function validVersion(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{1,16}$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    field('version', '照片资料版本', '请重新打开资料窗口后再保存');
  return Number(value);
}
function details(row: Asset, version: string): PhotoMetadataData {
  const record = photoRecord(row);
  return {
    id: row.id,
    version,
    fileCreatedAt: row.file_created_at,
    fileModifiedAt: row.file_modified_at,
    isTrashed: !!row.deleted_at,
    extracted: record.extracted,
    source: record.source,
    timeSource: record.timeSource,
    ...photoExifDto(row),
  };
}
async function commit(
  db: D1Database,
  identity: Identity,
  version: number,
  ids: string[],
  changes: { id: string; time: string; local: string; metadata: string }[],
) {
  const guard = crypto.randomUUID();
  const statements = [
    db
      .prepare('INSERT INTO web_photo_guards VALUES(?,?,?,?,?,?)')
      .bind(guard, identity.id, identity.session_id, version, JSON.stringify(ids), Date.now()),
  ];
  for (let at = 0; at < changes.length; at += 50)
    statements.push(
      db
        .prepare(
          `WITH updates AS MATERIALIZED (SELECT json_extract(value,'$.id') id,json_extract(value,'$.time') time,json_extract(value,'$.local') local,json_extract(value,'$.metadata') metadata FROM json_each(?))
    UPDATE assets AS a SET file_created_at=(SELECT time FROM updates WHERE id=a.id),local_date_time=(SELECT local FROM updates WHERE id=a.id),photo_metadata=(SELECT metadata FROM updates WHERE id=a.id)
    WHERE owner_id=? AND id IN(SELECT id FROM updates) AND EXISTS(SELECT 1 FROM web_photo_guards WHERE id=?)
    AND (file_created_at<>(SELECT time FROM updates WHERE id=a.id) OR local_date_time<>(SELECT local FROM updates WHERE id=a.id) OR photo_metadata<>(SELECT metadata FROM updates WHERE id=a.id))`,
        )
        .bind(JSON.stringify(changes.slice(at, at + 50)), identity.id, guard),
    );
  statements.push(db.prepare('DELETE FROM web_photo_guards WHERE id=?').bind(guard));
  try {
    await db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes('PHOTO_SESSION'))
      throw new HttpError(401, '登录会话：已失效，请重新登录后修改照片资料');
    if (message.includes('PHOTO_VERSION'))
      throw new HttpError(409, '照片资料：图库已变化，请重新打开窗口核对后再保存', 'version');
    if (message.includes('PHOTO_SCOPE'))
      throw new HttpError(404, '所选照片：存在已删除或无权修改的照片，请刷新后重新选择', 'ids');
    throw error;
  }
}
export async function photoMetadata(
  request: Request,
  env: Env,
  identity: Identity,
  rawId?: string,
  extract = false,
) {
  for (const key of new URL(request.url).searchParams.keys())
    field(key, '照片资料查询', '不接受查询参数，请移除');
  const db = env.IMMICH_CF_DB,
    id = rawId === undefined ? undefined : uuid(rawId);
  if (request.method === 'GET') {
    const found = await snapshot(db, identity.id, [id!]);
    await authenticate(request, db);
    return Response.json(details(found.rows[0]!, found.version));
  }
  sameOrigin(request);
  const input = await body(request);
  if (extract) {
    only(input, ['version']);
    const version = validVersion(input.version),
      found = await snapshot(db, identity.id, [id!]),
      row = found.rows[0]!;
    if (String(version) !== found.version)
      throw new HttpError(409, '照片资料：图库已变化，请重新打开窗口后读取', 'version');
    const exif = await readPhotoExif(env, row);
    const record = photoRecord(row);
    record.extracted = true;
    record.source = exif;
    await commit(
      db,
      identity,
      version,
      [id!],
      [
        {
          id: row.id,
          time: row.file_created_at,
          local: row.local_date_time ?? '',
          metadata: JSON.stringify(record),
        },
      ],
    );
    const current = await snapshot(db, identity.id, [id!]);
    await authenticate(request, db);
    return Response.json(details(current.rows[0]!, current.version));
  }
  only(input, [
    'ids',
    'version',
    'description',
    'latitude',
    'longitude',
    'dateTime',
    'timeZone',
    'shiftMinutes',
    'occurrence',
  ]);
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 1000)
    field('ids', '所选照片', '请提供 1～1000 张照片');
  const ids = input.ids.map((value) => uuid(value, 'ids'));
  if (new Set(ids).size !== ids.length) field('ids', '所选照片', '不能重复，请合并重复项目');
  const version = validVersion(input.version);
  if (
    !['description', 'latitude', 'longitude', 'dateTime', 'timeZone', 'shiftMinutes'].some((key) =>
      Object.hasOwn(input, key),
    )
  )
    field('照片资料', '照片资料', '请至少修改一项内容');
  if (
    input.description !== undefined &&
    (typeof input.description !== 'string' ||
      input.description.length > 2000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.description))
  )
    field('description', '照片描述', '最多 2000 个字符，不能包含控制字符');
  if (Object.hasOwn(input, 'latitude') !== Object.hasOwn(input, 'longitude'))
    field('latitude/longitude', '纬度、经度', '请同时填写两项，或同时清空以移除位置');
  if (Object.hasOwn(input, 'latitude')) {
    if ((input.latitude === null) !== (input.longitude === null))
      field('latitude/longitude', '纬度、经度', '请同时填写两项，或同时清空以移除位置');
    for (const [key, label, max] of [
      ['latitude', '纬度', 90],
      ['longitude', '经度', 180],
    ] as const)
      if (
        input[key] !== null &&
        (typeof input[key] !== 'number' ||
          !Number.isFinite(input[key]) ||
          Math.abs(input[key]) > max)
      )
        field(key, label, `请填写 -${max}～${max} 的有限数字，或清空位置`);
  }
  if (input.dateTime !== undefined && input.shiftMinutes !== undefined)
    field('dateTime/shiftMinutes', '拍摄时间、整体偏移', '只能选择一种修正方式');
  if (input.occurrence !== undefined && !['earlier', 'later'].includes(String(input.occurrence)))
    field('occurrence', '重复时刻', '请选择第一次或第二次出现的时间');
  if (input.occurrence !== undefined && input.dateTime === undefined)
    field('occurrence/dateTime', '重复时刻、拍摄时间', '仅设置当地拍摄时间时可以指定重复时刻');
  if (
    input.shiftMinutes !== undefined &&
    (!Number.isSafeInteger(input.shiftMinutes) ||
      input.shiftMinutes === 0 ||
      Math.abs(Number(input.shiftMinutes)) > 52596000)
  )
    field('shiftMinutes', '整体偏移', '请填写非零整数分钟，范围为 -52,596,000～52,596,000');
  let absolute: ReturnType<typeof resolvePhotoTime> | undefined, zone: string | undefined;
  try {
    if (input.timeZone !== undefined) zone = photoTimeZone(input.timeZone);
    if (input.dateTime !== undefined)
      absolute = resolvePhotoTime(
        input.dateTime,
        input.timeZone,
        input.occurrence as 'earlier' | 'later' | undefined,
      );
  } catch (error) {
    if (error instanceof PhotoTimeError) throw new HttpError(400, error.message, error.field);
    throw error;
  }
  const found = await snapshot(db, identity.id, ids);
  const changes = found.rows.map((row) => {
    const record = photoRecord(row);
    if (input.description !== undefined) record.overrides.description = input.description as string;
    if (Object.hasOwn(input, 'latitude')) {
      record.overrides.latitude = input.latitude as number | null;
      record.overrides.longitude = input.longitude as number | null;
    }
    let time = row.file_created_at;
    if (absolute) time = absolute.time;
    else if (input.shiftMinutes !== undefined) {
      const date = new Date(Date.parse(time) + Number(input.shiftMinutes) * 60000);
      if (
        !Number.isFinite(date.getTime()) ||
        !/^\d{4}-/.test(date.toISOString()) ||
        date.toISOString().startsWith('0000')
      )
        field('shiftMinutes', '整体偏移', '修正后的拍摄时间须在公元 1～9999 年内，请减少偏移');
      time = date.toISOString();
    }
    if (absolute || zone || input.shiftMinutes !== undefined) record.timeSource = 'manual';
    if (zone) record.timeZone = zone;
    const local =
      absolute || zone || input.shiftMinutes !== undefined
        ? record.timeZone
          ? photoWallTime(time, record.timeZone) + 'Z'
          : time
        : (row.local_date_time ?? '');
    if (local && (!/^\d{4}-/.test(local) || local.startsWith('0000')))
      field(
        'dateTime/timeZone',
        '拍摄时间、拍摄时区',
        '当地拍摄时间须在公元 1～9999 年内，请调整时间或时区',
      );
    return { id: row.id, time, local, metadata: JSON.stringify(record) };
  });
  await commit(db, identity, version, ids, changes);
  const current = await snapshot(db, identity.id, ids);
  await authenticate(request, db);
  return Response.json({
    updated: ids.length,
    version: current.version,
    items: current.rows.map((row) => ({ id: row.id, fileCreatedAt: row.file_created_at })),
  });
}
