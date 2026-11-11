export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}
export interface GeoPoint {
  id: string;
  latitude: number;
  longitude: number;
}
export interface GeoCluster {
  key: string;
  count: number;
  latitude: number;
  longitude: number;
  coverId: string;
  bounds: GeoBounds;
}
export const mapViews = ['library', 'photos', 'favorites', 'archive', 'album'] as const;
export type MapView = (typeof mapViews)[number];
export const mercatorLatitude = 85.0511287798066;
export class GeoError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}
export function geoBounds(value: string): GeoBounds {
  const values = value.split(',');
  if (
    value.length > 160 ||
    values.length !== 4 ||
    values.some((part) => !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(part))
  )
    throw new GeoError('bounds', '地图范围：请提供南纬度、西经度、北纬度、东经度四个有效数字');
  const [south, west, north, east] = values.map(Number) as [number, number, number, number];
  if (
    ![south, west, north, east].every(Number.isFinite) ||
    south < -90 ||
    north > 90 ||
    south > north ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180
  )
    throw new GeoError(
      'bounds',
      '地图范围：纬度须在 -90～90、经度须在 -180～180，南纬度不能大于北纬度',
    );
  return { south, west, north, east };
}
export const boundsKey = (bounds: GeoBounds) =>
  [bounds.south, bounds.west, bounds.north, bounds.east].join(',');
export const wrapLongitude = (longitude: number) =>
  longitude >= -180 && longitude < 180
    ? longitude
    : ((((longitude + 180) % 360) + 360) % 360) - 180;
export function inGeoBounds(point: { latitude: number; longitude: number }, bounds: GeoBounds) {
  const { latitude, longitude } = point;
  if (latitude < bounds.south || latitude > bounds.north) return false;
  return (
    (bounds.west <= bounds.east
      ? longitude >= bounds.west && longitude <= bounds.east
      : longitude >= bounds.west || longitude <= bounds.east) ||
    (longitude === -180 && bounds.east === 180) ||
    (longitude === 180 && bounds.west === -180)
  );
}
export function geoExtent(points: { latitude: number; longitude: number }[]): GeoBounds | null {
  if (!points.length) return null;
  let south = 90,
    north = -90;
  const longitudes = points
    .map((point) => {
      south = Math.min(south, point.latitude);
      north = Math.max(north, point.latitude);
      return wrapLongitude(point.longitude);
    })
    .sort((a, b) => a - b);
  let largest = -1,
    gap = 0;
  for (let i = 0; i < longitudes.length; i++) {
    const distance =
      longitudes[(i + 1) % longitudes.length]! +
      (i === longitudes.length - 1 ? 360 : 0) -
      longitudes[i]!;
    if (distance > largest) {
      largest = distance;
      gap = i;
    }
  }
  return { south, north, west: longitudes[(gap + 1) % longitudes.length]!, east: longitudes[gap]! };
}
export function geoClusters(points: GeoPoint[], requestedZoom: number) {
  for (let zoom = requestedZoom; zoom >= 0; zoom--) {
    const groups = new Map<string, GeoPoint[]>(),
      world = 256 * 2 ** zoom;
    for (const point of points) {
      const latitude =
        (Math.max(-mercatorLatitude, Math.min(mercatorLatitude, point.latitude)) * Math.PI) / 180;
      const x = ((wrapLongitude(point.longitude) + 180) / 360) * world;
      const y = ((1 - Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / Math.PI) / 2) * world;
      const key = `${zoom}:${Math.floor(x / 80)}:${Math.floor(y / 80)}`;
      const group = groups.get(key);
      if (group) group.push(point);
      else groups.set(key, [point]);
    }
    if (groups.size > 512 && zoom > 0) continue;
    const clusters: GeoCluster[] = [...groups].map(([key, group]) => ({
      key,
      count: group.length,
      latitude: group.reduce((sum, point) => sum + point.latitude, 0) / group.length,
      longitude:
        group.reduce((sum, point) => sum + wrapLongitude(point.longitude), 0) / group.length,
      coverId: group[0]!.id,
      bounds: geoExtent(group)!,
    }));
    return { zoom, clusters };
  }
  return { zoom: 0, clusters: [] as GeoCluster[] };
}
