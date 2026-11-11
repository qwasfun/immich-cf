import { authenticate, type Identity } from '../poc/auth';
import { HttpError, invalid } from '../poc/http';
import { MemoryDateError, memoryContext } from '../memory-date';
import { PhotoTimeError, photoWallTime } from '../photo-time';
import { galleryState, readGalleryState } from './gallery-scope';

export function readMemoryContext(params: URLSearchParams) {
  try {
    return memoryContext(params);
  } catch (error) {
    if (error instanceof MemoryDateError || error instanceof PhotoTimeError)
      throw new HttpError(400, error.message, error.field);
    throw error;
  }
}

export async function memories(request: Request, env: Env, identity: Identity) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!['memoryDate', 'timeZone', 'version'].includes(key))
      invalid(key, '此查询参数不受支持，请移除');
    if (params.getAll(key).length !== 1) invalid(key, '请只提供一个值');
  }
  const context = readMemoryContext(params),
    db = env.IMMICH_CF_DB;
  if (params.has('version')) {
    const state = await galleryState(db, identity, '').all();
    await authenticate(request, db);
    const version = readGalleryState(state);
    if (params.get('version') === version)
      return Response.json({ version, unchanged: true, ...context });
  }
  const [state, rows] = await db.batch([
    galleryState(db, identity, ''),
    db
      .prepare(
        `SELECT id,file_created_at FROM assets WHERE owner_id=? AND media_type='IMAGE'
      AND visibility='timeline' AND archived=0 AND deleted_at IS NULL
      ORDER BY julianday(file_created_at) DESC,id DESC`,
      )
      .bind(identity.id),
  ]);
  const years = new Map<
    number,
    { year: number; yearsAgo: number; count: number; coverId: string }
  >();
  for (const row of rows!.results as { id: string; file_created_at: string }[]) {
    const date = photoWallTime(row.file_created_at, context.timeZone).slice(0, 10);
    const year = Number(date.slice(0, 4));
    if (year >= context.year || date.slice(5) !== context.date.slice(5)) continue;
    const group = years.get(year);
    if (group) group.count++;
    else years.set(year, { year, yearsAgo: context.year - year, count: 1, coverId: row.id });
  }
  await authenticate(request, db);
  return Response.json({
    ...context,
    version: readGalleryState(state!),
    total: [...years.values()].reduce((total, year) => total + year.count, 0),
    years: [...years.values()].sort((a, b) => b.year - a.year),
  });
}
