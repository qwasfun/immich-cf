import { authenticate, type Identity } from '../poc/auth';
import { invalid } from '../poc/http';
import { geoClusters, geoExtent, inGeoBounds, type GeoPoint } from '../geo';
import { galleryScope, galleryState, readGalleryState } from './gallery-scope';
import { geoLatitude, geoLongitude, mapScope } from './map-scope';

export async function photoMap(request: Request, env: Env, identity: Identity) {
  const params = new URL(request.url).searchParams;
  if (params.getAll('view').length > 1) invalid('view', '地图视图：请只提供一个值');
  if (params.has('view') && params.get('view') !== 'map') invalid('view', '地图视图：请选择 map');
  params.set('view', 'map');
  // Validate before removing viewport bounds, so an invalid/duplicate bound is never ignored.
  galleryScope(params, identity, ['zoom']);
  const map = mapScope(params),
    zoom = params.get('zoom') ?? '2';
  if (!/^(?:[0-9]|1[0-9])$/.test(zoom)) invalid('zoom', '地图缩放：请选择 0～19 的整数级别');
  const all = new URLSearchParams(params);
  all.delete('bounds');
  const scope = galleryScope(all, identity, ['zoom']),
    db = env.IMMICH_CF_DB;
  const [state, rows] = await db.batch([
    galleryState(db, identity, scope.album),
    db
      .prepare(
        `SELECT a.id,${geoLatitude} latitude,${geoLongitude} longitude FROM assets a WHERE ${scope.where}
      ORDER BY ${scope.sort} ${scope.ascending ? 'ASC' : 'DESC'},a.id ${scope.ascending ? 'ASC' : 'DESC'}`,
      )
      .bind(...scope.args),
  ]);
  const points = rows!.results as unknown as GeoPoint[];
  const visible = map.bounds ? points.filter((point) => inGeoBounds(point, map.bounds!)) : points;
  const grouped = geoClusters(visible, Number(zoom));
  await authenticate(request, db);
  return Response.json({
    version: readGalleryState(state!),
    total: points.length,
    visible: visible.length,
    extent: geoExtent(points),
    ...grouped,
  });
}
