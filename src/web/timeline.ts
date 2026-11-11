import { authenticate, type Identity } from '../poc/auth';
import { invalid } from '../poc/http';
import { galleryScope, galleryState, readGalleryState } from './gallery-scope';

export async function timeline(request: Request, env: Env, identity: Identity) {
  const params = new URL(request.url).searchParams;
  const scope = galleryScope(params, identity, ['timeZone', 'version']);
  if (scope.view === 'trash') invalid('view', '年月导航适用于照片、收藏和个人相册');
  const timeZone = params.get('timeZone') ?? 'UTC';
  let formatter: Intl.DateTimeFormat;
  try {
    if (timeZone.length > 100) throw Error();
    formatter = new Intl.DateTimeFormat('en', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
    });
  } catch {
    invalid('timeZone', '请选择有效的 IANA 时区');
  }
  const db = env.IMMICH_CF_DB;
  if (params.has('version')) {
    const state = await galleryState(db, identity, scope.album).all();
    await authenticate(request, db);
    const version = readGalleryState(state);
    if (params.get('version') === version) return Response.json({ version, unchanged: true });
  }
  const [state, result] = await db.batch([
    galleryState(db, identity, scope.album),
    db
      .prepare(
        `SELECT a.id,a.file_created_at FROM assets a WHERE ${scope.where}
      ORDER BY ${scope.sort} ${scope.ascending ? 'ASC' : 'DESC'},a.id ${scope.ascending ? 'ASC' : 'DESC'}`,
      )
      .bind(...scope.args),
  ]);
  await authenticate(request, db);
  const version = readGalleryState(state!);
  const months = new Map<
    string,
    {
      key: string;
      year: number;
      month: number;
      count: number;
      anchorTime: string;
      anchorId: string;
    }
  >();
  for (const row of result!.results as { id: string; file_created_at: string }[]) {
    const date = new Date(row.file_created_at);
    const parts = formatter.formatToParts(date);
    const year = Number(parts.find((p) => p.type === 'year')!.value);
    const month = Number(parts.find((p) => p.type === 'month')!.value);
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    const bucket = months.get(key);
    if (bucket) bucket.count++;
    else
      months.set(key, {
        key,
        year,
        month,
        count: 1,
        anchorTime: date.toISOString(),
        anchorId: row.id,
      });
  }
  return Response.json({ version, timeZone, months: [...months.values()] });
}
