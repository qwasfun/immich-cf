import { GeoError, geoBounds, boundsKey, mapViews, type MapView } from '../geo';
import { HttpError, invalid } from '../poc/http';

const coordinate = (
  name: string,
  type = false,
) => `CASE WHEN json_type(a.photo_metadata,'$.overrides.${name}') IS NOT NULL
  THEN ${type ? 'json_type' : 'json_extract'}(a.photo_metadata,'$.overrides.${name}') ELSE ${type ? 'json_type' : 'json_extract'}(a.photo_metadata,'$.source.${name}') END`;
export const geoLatitude = '(' + coordinate('latitude') + ')';
export const geoLongitude = '(' + coordinate('longitude') + ')';

export function mapScope(params: URLSearchParams) {
  const view = params.get('mapView') ?? 'library';
  if (!mapViews.includes(view as MapView))
    invalid('mapView', '位置范围：请选择全部照片、照片、收藏、归档或个人相册');
  let bounds;
  try {
    bounds = params.has('bounds') ? geoBounds(params.get('bounds')!) : null;
  } catch (error) {
    if (error instanceof GeoError) throw new HttpError(400, error.message, error.field);
    throw error;
  }
  let where = `(${coordinate('latitude', true)}) IN('integer','real') AND ${geoLatitude} BETWEEN -90 AND 90
    AND (${coordinate('longitude', true)}) IN('integer','real') AND ${geoLongitude} BETWEEN -180 AND 180`;
  const args: number[] = [];
  if (bounds) {
    where += ` AND ${geoLatitude}>=? AND ${geoLatitude}<=? AND ((${geoLongitude}>=? ${bounds.west <= bounds.east ? 'AND' : 'OR'} ${geoLongitude}<=?)${bounds.east === 180 ? ` OR ${geoLongitude}=-180` : ''}${bounds.west === -180 ? ` OR ${geoLongitude}=180` : ''})`;
    args.push(bounds.south, bounds.north, bounds.west, bounds.east);
  }
  const key = new URLSearchParams({
    mapView: view,
    ...(bounds ? { bounds: boundsKey(bounds) } : {}),
  }).toString();
  return { view, bounds, where, args, key };
}
